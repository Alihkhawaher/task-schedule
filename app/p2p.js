// V6 P2P Module — Trystero (Nostr-based WebRTC signaling)
// Direct browser-to-browser connections via Nostr relays for signaling only
// Actual data flows via WebRTC, end-to-end encrypted
//
// Security Model:
// - Random room ID (non-reversible, generated at family creation)
// - Admin approval gate (new devices must be approved before receiving data)
// - Approval tokens (per-device, hash-verified for reconnection)

const P2P = {
    room: null,
    roomId: null,
    selfId: null,
    actions: {},      // { name: { send, onMessage } }
    onPeerJoin: null,
    onPeerLeave: null,
    onMessage: null,
    onJoinRequest: null,    // callback when a new device requests to join
    connectedPeers: new Set(),
    _joining: false,  // Guard against duplicate joinRoom calls
    _joined: false,   // Track if we've successfully joined

    PEER_STORAGE_KEY: 'taskSchedule_peers',
    DEVICE_NAME_KEY: 'taskSchedule_deviceName',
    APPROVED_TOKENS_KEY: 'taskSchedule_approvedTokens',  // hash(token) → { deviceName, approvedAt }
    STORED_TOKEN_KEY: 'taskSchedule_approvalToken',       // raw token for this device (if approved)
    ROOM_ID_KEY_PREFIX: 'taskSchedule_roomId_',           // + familyCode
    peerList: {},
    deviceName: null,

    // ==================== INITIALIZATION ====================

    init(options = {}) {
        this.onPeerJoin = options.onPeerJoin || (() => {});
        this.onPeerLeave = options.onPeerLeave || (() => {});
        this.onMessage = options.onMessage || (() => {});
        this.onJoinRequest = options.onJoinRequest || null;

        this._loadPeerList();

        const familyCode = options.familyCode || sessionStorage.getItem('familyCode');
        if (!familyCode) return this.selfId;

        // Get the random room ID from localStorage
        const storedRoomId = this.getStoredRoomId(familyCode);
        if (!storedRoomId) {
            console.warn('[P2P] No room ID stored for family:', familyCode);
            return this.selfId;
        }

        // Trystero loads as ES module (deferred), so we need to wait
        if (typeof window.Trystero !== 'undefined' && window.Trystero.joinRoom) {
            this.joinRoom(storedRoomId);
        } else {
            console.log('[P2P] Waiting for Trystero to load...');
            window.addEventListener('trystero-ready', () => {
                console.log('[P2P] Trystero ready, joining room');
                if (!this._joined) this.joinRoom(storedRoomId);
            });
            // Fallback: poll for Trystero (in case event fires before listener)
            const checkInterval = setInterval(() => {
                if (window.Trystero && window.Trystero.joinRoom) {
                    clearInterval(checkInterval);
                    if (!this._joined && !this._joining) this.joinRoom(storedRoomId);
                }
            }, 500);
            // Stop polling after 10 seconds
            setTimeout(() => clearInterval(checkInterval), 10000);
        }

        return this.selfId;
    },

    joinRoom(roomId) {
        if (!window.Trystero || !window.Trystero.joinRoom) {
            console.warn('[P2P] Trystero not loaded');
            return;
        }

        // Guard: prevent duplicate joinRoom calls
        if (this._joining || this._joined) {
            console.log('[P2P] Already joined or joining, skipping. joined:', this._joined, 'joining:', this._joining);
            return;
        }
        this._joining = true;

        if (this.room) {
            console.log('[P2P] Already in room, leaving first');
            this.room.leave();
        }

        this.roomId = roomId;
        this.selfId = window.Trystero.selfId;

        try {
            this.room = window.Trystero.joinRoom(
                { appId: 'task-schedule-family' },
                roomId
            );
            this._joined = true;
            this._joining = false;
            console.log('[P2P] Joined room (hash):', roomId.substring(0, 12) + '...');
        } catch (e) {
            this._joining = false;
            console.warn('[P2P] Failed to join room:', e);
            return;
        }

        // Create data actions (Trystero returns objects with .send() and .onMessage)
        this.actions = {
            data: this.room.makeAction('data'),
            family: this.room.makeAction('family'),
            request: this.room.makeAction('request'),
            join: this.room.makeAction('join'),        // join-request from new devices
            approval: this.room.makeAction('approval')  // approval/rejection from admin
        };

        // Handle incoming messages — Trystero sends (data, {peerId}) not (data, peerId)
        this.actions.data.onMessage = (data, meta) => {
            const peerId = typeof meta === 'object' ? meta.peerId : meta;
            if (typeof peerId !== 'string') {
                console.warn('[P2P] Unexpected peerId type:', typeof peerId, peerId, meta);
                return;
            }
            this.onMessage(peerId, data);
        };

        this.actions.family.onMessage = (data, meta) => {
            const peerId = typeof meta === 'object' ? meta.peerId : meta;
            if (typeof peerId !== 'string') {
                console.warn('[P2P] Unexpected peerId type:', typeof peerId, peerId, meta);
                return;
            }
            this.onMessage(peerId, { type: 'family-sync', ...data });
        };

        this.actions.request.onMessage = (data, meta) => {
            const peerId = typeof meta === 'object' ? meta.peerId : meta;
            if (typeof peerId !== 'string') {
                console.warn('[P2P] Unexpected peerId type:', typeof peerId, peerId, meta);
                return;
            }
            if (data.type === 'family-request') {
                // Only respond to family data requests if peer is approved
                const familyCode = sessionStorage.getItem('familyCode');
                const storageKey = 'taskSchedule_' + familyCode;
                try {
                    const raw = localStorage.getItem(storageKey);
                    if (raw) {
                        const localData = JSON.parse(raw);
                        this.actions.family.send({
                            familyCode: familyCode,
                            familyName: sessionStorage.getItem('familyName') || '',
                            members: localData.users || {},
                            tasks: localData.tasks || {},
                            completions: localData.completions || {}
                        }, { target: peerId });
                    }
                } catch (e) {}
            }
        };

        // Handle join-request from new devices
        this.actions.join.onMessage = async (data, meta) => {
            const peerId = typeof meta === 'object' ? meta.peerId : meta;
            if (typeof peerId !== 'string') {
                console.warn('[P2P] Unexpected peerId type:', typeof peerId, peerId, meta);
                return;
            }
            console.log('[P2P] Join request from:', peerId, data);

            if (data.type === 'join-request') {
                // Check if device has a stored approval token
                if (data.token) {
                    const tokenValid = await this.verifyApprovalToken(data.token);
                    if (tokenValid) {
                        console.log('[P2P] Auto-approving known device:', peerId);
                        // Update lastSeen for this token
                        this.updateApprovedTokenSeen(data.token);
                        // Send family data directly (peer already approved)
                        this.sendApprovalToPeer(peerId);
                        return;
                    }
                }

                // Unknown device or no token — delegate to callback (admin approval dialog)
                if (this.onJoinRequest) {
                    this.onJoinRequest(peerId, {
                        type: 'join-request',
                        deviceName: data.deviceName || 'Unknown Device',
                        peerId: peerId
                    });
                }
            }
        };

        // Handle approval/rejection from admin
        this.actions.approval.onMessage = (data, meta) => {
            const peerId = typeof meta === 'object' ? meta.peerId : meta;
            if (typeof peerId !== 'string') {
                console.warn('[P2P] Unexpected peerId type:', typeof peerId, peerId, meta);
                return;
            }
            if (data.type === 'approved') {
                console.log('[P2P] Connection approved by admin');
                // Store the approval token for future reconnections
                if (data.token) {
                    this.storeApprovalToken(data.token);
                }
                // Notify the app that we're approved
                this.onMessage(peerId, { type: 'connection-approved', ...data });
            } else if (data.type === 'rejected') {
                console.log('[P2P] Connection rejected by admin');
                this.onMessage(peerId, { type: 'connection-rejected' });
            }
        };

        // Peer join/leave
        this.room.onPeerJoin = (peerId) => {
            console.log('[P2P] Peer joined:', peerId);
            this.connectedPeers.add(peerId);
            const myName = this.getDeviceName();
            this.peerList[peerId] = { name: peerId, lastSeen: Date.now() };
            this._savePeerList();
            this.onPeerJoin(peerId, peerId);

            // Send our device name to the new peer
            if (myName) {
                this.send(peerId, { type: 'peer-name', name: myName });
            }

            // NOTE: Do NOT auto-send family data here.
            // The new device must send a join-request first, and admin must approve.
        };

        this.room.onPeerLeave = (peerId) => {
            console.log('[P2P] Peer left:', peerId);
            this.connectedPeers.delete(peerId);
            if (this.peerList[peerId]) {
                this.peerList[peerId].lastSeen = Date.now();
            }
            this._savePeerList();
            this.onPeerLeave(peerId);
        };

        console.log('[P2P] Joined room:', roomId.substring(0, 12) + '...', 'as', this.selfId);
    },

    // ==================== JOIN REQUEST (New Device) ====================

    sendJoinRequest(deviceName) {
        const myName = deviceName || this.getDeviceName();
        const storedToken = this.getStoredApprovalToken();

        if (this.actions.join) {
            this.actions.join.send({
                type: 'join-request',
                deviceName: myName || 'New Device',
                token: storedToken || null
            });
            console.log('[P2P] Sent join-request, device:', myName, 'token:', storedToken ? 'yes' : 'no');
            return true;
        }
        return false;
    },

    // ==================== APPROVAL (Admin Side) ====================

    async approvePeer(peerId, deviceName) {
        // Generate a random approval token
        const token = this.generateApprovalToken();

        // Store the hash of the token FIRST (await to avoid race condition)
        await this.storeApprovedTokenHash(token, deviceName || 'Unknown Device');

        // Send approval + token to the peer
        if (this.actions.approval) {
            this.actions.approval.send({
                type: 'approved',
                token: token
            }, { target: peerId });
        }

        // Send family data
        this.sendFamilyDataToPeer(peerId);

        console.log('[P2P] Approved peer:', peerId);
        return token;
    },

    rejectPeer(peerId) {
        if (this.actions.approval) {
            this.actions.approval.send({
                type: 'rejected'
            }, { target: peerId });
        }
        console.log('[P2P] Rejected peer:', peerId);
    },

    async sendApprovalToPeer(peerId) {
        // Auto-approve: send family data directly (peer already has valid token)
        const familyCode = sessionStorage.getItem('familyCode');
        if (!familyCode) return;

        const storageKey = 'taskSchedule_' + familyCode;
        try {
            const raw = localStorage.getItem(storageKey);
            const localData = raw ? JSON.parse(raw) : {};
            this.sendFamilyData(peerId, {
                familyCode: familyCode,
                familyName: sessionStorage.getItem('familyName') || '',
                members: localData.users || {},
                tasks: localData.tasks || {},
                completions: localData.completions || {}
            });
        } catch (e) {}
    },

    // ==================== APPROVAL TOKEN MANAGEMENT ====================

    generateApprovalToken() {
        // Generate 32 random bytes as hex string
        const array = new Uint8Array(32);
        crypto.getRandomValues(array);
        return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
    },

    async hashToken(token) {
        const encoder = new TextEncoder();
        const data = encoder.encode(token + 'task-schedule-token-salt');
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    },

    async storeApprovedTokenHash(token, deviceName) {
        // Store hash(token) → { deviceName, approvedAt } (admin side)
        try {
            const hash = await this.hashToken(token);
            const raw = localStorage.getItem(this.APPROVED_TOKENS_KEY);
            const tokens = raw ? JSON.parse(raw) : {};
            tokens[hash] = { deviceName, approvedAt: Date.now(), lastSeen: Date.now() };
            localStorage.setItem(this.APPROVED_TOKENS_KEY, JSON.stringify(tokens));
        } catch (e) {
            console.warn('[P2P] Failed to store approved token hash:', e);
        }
    },

    async verifyApprovalToken(token) {
        // Compute hash of incoming token and check against stored approved hashes
        try {
            const hash = await this.hashToken(token);
            const raw = localStorage.getItem(this.APPROVED_TOKENS_KEY);
            if (!raw) return false;
            const tokens = JSON.parse(raw);
            return !!tokens[hash];
        } catch (e) {
            return false;
        }
    },

    updateApprovedTokenSeen(token) {
        // Update lastSeen for the approved token
        this.hashToken(token).then(hash => {
            try {
                const raw = localStorage.getItem(this.APPROVED_TOKENS_KEY);
                if (raw) {
                    const tokens = JSON.parse(raw);
                    if (tokens[hash]) {
                        tokens[hash].lastSeen = Date.now();
                        localStorage.setItem(this.APPROVED_TOKENS_KEY, JSON.stringify(tokens));
                    }
                }
            } catch (e) {}
        });
    },

    storeApprovalToken(token) {
        // Store the raw token on the approved device (client side)
        try {
            localStorage.setItem(this.STORED_TOKEN_KEY, token);
        } catch (e) {}
    },

    getStoredApprovalToken() {
        try {
            return localStorage.getItem(this.STORED_TOKEN_KEY);
        } catch (e) {
            return null;
        }
    },

    removeApprovalToken() {
        try {
            localStorage.removeItem(this.STORED_TOKEN_KEY);
        } catch (e) {}
    },

    // ==================== APPROVED TOKENS LIST (Admin) ====================

    getApprovedTokens() {
        try {
            const raw = localStorage.getItem(this.APPROVED_TOKENS_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (e) {
            return {};
        }
    },

    async revokeApprovedToken(tokenHash) {
        try {
            const raw = localStorage.getItem(this.APPROVED_TOKENS_KEY);
            if (raw) {
                const tokens = JSON.parse(raw);
                delete tokens[tokenHash];
                localStorage.setItem(this.APPROVED_TOKENS_KEY, JSON.stringify(tokens));
            }
        } catch (e) {}
    },

    async isTokenApproved(token) {
        const hash = await this.hashToken(token);
        const tokens = this.getApprovedTokens();
        return !!tokens[hash];
    },

    // ==================== ROOM ID MANAGEMENT ====================

    generateRoomId() {
        // Generate 32 random bytes as hex string
        const array = new Uint8Array(32);
        crypto.getRandomValues(array);
        return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
    },

    storeRoomId(familyCode, roomId) {
        try {
            localStorage.setItem(this.ROOM_ID_KEY_PREFIX + familyCode, roomId);
        } catch (e) {}
    },

    getStoredRoomId(familyCode) {
        try {
            return localStorage.getItem(this.ROOM_ID_KEY_PREFIX + familyCode);
        } catch (e) {
            return null;
        }
    },

    // ==================== DATA SENDING ====================

    send(peerId, message) {
        if (this.actions.data) {
            this.actions.data.send(message, { target: peerId });
            return true;
        }
        return false;
    },

    broadcast(message) {
        if (this.actions.data) {
            this.actions.data.send(message);
        }
    },

    sendFamilyData(peerId, familyData) {
        if (this.actions.family) {
            if (peerId) {
                this.actions.family.send(familyData, { target: peerId });
            } else {
                this.actions.family.send(familyData);
            }
        }
    },

    sendFamilyDataToPeer(peerId) {
        const familyCode = sessionStorage.getItem('familyCode');
        if (!familyCode) return;

        const storageKey = 'taskSchedule_' + familyCode;
        try {
            const raw = localStorage.getItem(storageKey);
            const localData = raw ? JSON.parse(raw) : {};
            this.sendFamilyData(peerId, {
                familyCode: familyCode,
                familyName: sessionStorage.getItem('familyName') || '',
                members: localData.users || {},
                tasks: localData.tasks || {},
                completions: localData.completions || {}
            });
        } catch (e) {}
    },

    requestFamilyData(peerId) {
        if (this.actions.request) {
            this.actions.request.send({ type: 'family-request' }, { target: peerId });
        }
    },

    // ==================== DEVICE NAME ====================

    getDeviceName() {
        if (this.deviceName) return this.deviceName;
        this.deviceName = localStorage.getItem(this.DEVICE_NAME_KEY) || '';
        return this.deviceName;
    },

    setDeviceName(name) {
        this.deviceName = name || '';
        try { localStorage.setItem(this.DEVICE_NAME_KEY, this.deviceName); } catch (e) {}
        // Broadcast name to all connected peers
        if (this.actions.data && this.deviceName) {
            this.broadcast({ type: 'peer-name', name: this.deviceName });
        }
    },

    // ==================== PEER INFO ====================

    getConnectedPeers() {
        const connected = {};
        this.connectedPeers.forEach(id => {
            connected[id] = this.peerList[id] || { name: id, lastSeen: Date.now() };
        });
        return connected;
    },

    getAllPeers() {
        return { ...this.peerList };
    },

    removePeer(peerId) {
        this.connectedPeers.delete(peerId);
        delete this.peerList[peerId];
        this._savePeerList();
    },

    // ==================== QR CODE ====================

    generateShareQR(familyCode, roomId) {
        // The share link includes family code AND random room ID
        const baseUrl = window.location.origin + window.location.pathname.replace(/\/app\/index\.html$/, '/index.html');
        const url = baseUrl + '?join=' + encodeURIComponent(familyCode) + '&room=' + encodeURIComponent(roomId);

        if (typeof qrcode !== 'undefined') {
            const qr = qrcode(0, 'M');
            qr.addData(url);
            qr.make();
            return { svg: qr.createSvgTag(4, 0), url: url };
        }
        return { svg: '', url: url };
    },

    parseConnectionHash() {
        // No longer needed — Trystero handles connection automatically
        return null;
    },

    clearHash() {
        // No-op — Trystero doesn't use URL hash
    },

    // ==================== STORAGE ====================

    _loadPeerList() {
        try {
            const raw = localStorage.getItem(this.PEER_STORAGE_KEY);
            if (raw) {
                this.peerList = JSON.parse(raw);
                // Auto-purge peers not seen in 1 hour
                const cutoff = Date.now() - (60 * 60 * 1000);
                Object.keys(this.peerList).forEach(id => {
                    if (this.peerList[id].lastSeen < cutoff) {
                        delete this.peerList[id];
                    }
                });
            }
        } catch (e) {}
    },

    _savePeerList() {
        try {
            localStorage.setItem(this.PEER_STORAGE_KEY, JSON.stringify(this.peerList));
        } catch (e) {}
    },

    destroy() {
        if (this.room) {
            this.room.leave();
            this.room = null;
        }
    }
};

window.addEventListener('beforeunload', () => P2P.destroy());