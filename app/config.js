// V7 Config - Settings panel logic
// References shared variables from app.js: localUsers, localTasks, usersNode, tasksNode, completionsNode,
// lastPinVerification, pinGracePeriod, hashPin, escapeHtml, family, familyCode

// Load settings data when overlay opens
function loadSettingsData() {
    loadUsers();
    loadTasks();
    loadEvents();
    loadScheduleSettings();
    loadDeviceName();
    if (typeof loadConnectedDevices === 'function') loadConnectedDevices();
    if (typeof loadShareSection === 'function') loadShareSection();
}

// Device name
function loadDeviceName() {
    if (typeof P2P !== 'undefined') {
        const name = P2P.getDeviceName();
        $('#deviceNameInput').val(name);
    }
}

function saveDeviceName() {
    const name = $('#deviceNameInput').val().trim();
    if (!name) { Swal.fire('تنبيه', 'يرجى إدخال اسم الجهاز', 'warning'); return; }
    if (typeof P2P !== 'undefined') {
        P2P.setDeviceName(name);
    }
    Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'تم حفظ اسم الجهاز', showConfirmButton: false, timer: 1500 });
}

// Load schedule settings (grace period, start date)
function loadScheduleSettings() {
    family.get('settings').once((settings) => {
        if (settings) {
            if (settings.pinGracePeriod) $('#gracePeriod').val(settings.pinGracePeriod);
            if (settings.startDate) $('#startDate').val(settings.startDate);
        }
    });
}

// Save schedule settings (grace period applies)
function saveScheduleSettings() {
    requirePinForAction(function() {
        const gracePeriod = parseInt($('#gracePeriod').val()) || 1;
        const startDate = $('#startDate').val() || null;

        family.get('settings').put({
            pinGracePeriod: gracePeriod,
            startDate: startDate
        });

        // Update in-memory values
        pinGracePeriod = gracePeriod * 60 * 1000;
        schedulerStartDate = startDate;

        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'تم حفظ الإعدادات', showConfirmButton: false, timer: 1500 });
    });
}

// User management
function loadUsers() {
    const users = Object.entries(localUsers).map(([id, u]) => ({ id, ...u }));
    const html = users.map(u => `<tr>
        <td>${escapeHtml(u.name)}</td>
        <td><span class="badge bg-secondary">${u.pinHash ? '••••' : '<span class="text-warning">غير محدد</span>'}</span></td>
        <td>
            <button class="btn btn-sm btn-outline-primary me-1" onclick="editPin('${u.id}')" title="تغيير الرمز"><i class="bi bi-key"></i></button>
            <button class="btn btn-sm btn-danger" onclick="deleteUser('${u.id}')" title="حذف"><i class="bi bi-trash"></i></button>
        </td>
    </tr>`).join('');
    $('#usersTable').html(html);

    // Also populate task form user dropdown
    const sel = $('#taskUserId');
    sel.empty();
    users.forEach(u => {
        sel.append(`<option value="${u.id}">${escapeHtml(u.name)}</option>`);
    });
}

async function addUser() {
    const name = $('#userName').val().trim();
    const pin = $('#userPin').val().trim();
    if (!name) { Swal.fire('تنبيه', 'يرجى إدخال اسم المستخدم', 'warning'); return; }
    if (pin && !/^\d{4,6}$/.test(pin)) { Swal.fire('تنبيه', 'الرمز يجب أن يكون 4 إلى 6 أرقام', 'warning'); return; }

    requirePinForAction(async function() {
        const userData = { name, role: 'member', createdAt: Date.now() };
        if (pin) userData.pinHash = await hashPin(pin);

        const id = name.toLowerCase().replace(/\s+/g, '_');
        usersNode.get(id).put(userData);
        localUsers[id] = userData;
        saveToLocal();
        if (typeof broadcastCurrentData === 'function') broadcastCurrentData();
        $('#userName').val('');
        $('#userPin').val('');
        loadUsers();
        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'تم إضافة المستخدم', showConfirmButton: false, timer: 1500 });
    });
}

async function editPin(id) {
    const user = localUsers[id];
    if (!user) return;

    requirePinForAction(async function() {
        const { value: pin } = await Swal.fire({
            title: `تغيير الرمز لـ ${user.name}`,
            html: '<p class="text-muted">أدخل الرمز الجديد (4-6 أرقام)</p>',
            input: 'password', inputPlaceholder: '••••',
            inputAttributes: { maxlength: 6, inputmode: 'numeric', style: 'text-align:center;font-size:28px;letter-spacing:12px;' },
            showCancelButton: true, confirmButtonText: 'حفظ', cancelButtonText: 'إزالة الرمز',
            preConfirm: (v) => { if (v && !/^\d{4,6}$/.test(v)) { Swal.showValidationMessage('الرمز يجب أن يكون 4 إلى 6 أرقام'); return false; } return v; }
        });
        if (pin !== undefined) {
            const update = { pinHash: pin ? await hashPin(pin) : null };
            usersNode.get(id).put(update);
            localUsers[id] = { ...user, ...update };
            saveToLocal();
            if (typeof broadcastCurrentData === 'function') broadcastCurrentData();
            loadUsers();
            Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: pin ? 'تم تحديث الرمز' : 'تم إزالة الرمز', showConfirmButton: false, timer: 1500 });
        }
    });
}

async function deleteUser(id) {
    const result = await Swal.fire({ title: 'تأكيد الحذف', text: 'هل أنت متأكد من حذف هذا المستخدم؟', icon: 'warning', showCancelButton: true, confirmButtonText: 'نعم، احذف', cancelButtonText: 'إلغاء' });
    if (!result.isConfirmed) return;

    requirePinForAction(function() {
        usersNode.get(id).put(null);
        delete localUsers[id];
        saveToLocal();
        if (typeof broadcastCurrentData === 'function') broadcastCurrentData();
        loadUsers();
        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'تم حذف المستخدم', showConfirmButton: false, timer: 1500 });
    });
}

// Task management (per-user)
function loadTasks() {
    const users = Object.entries(localUsers).map(([id, u]) => ({ id, ...u }));
    const userNameMap = {};
    users.forEach(u => { userNameMap[u.id] = u.name; });

    const tasks = Object.entries(localTasks).map(([id, t]) => ({ id, ...t }));
    const DAY_NAMES_SHORT = ['أحد', 'إثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'];

    const html = tasks.map(t => {
        const daysStr = (t.daysOfWeek || []).map(i => DAY_NAMES_SHORT[i]).join(' ') || '—';
        const rangeStr = `${t.startDate || '—'} ← ${t.endDate || 'بدون نهاية'}`;
        return `<tr>
            <td>${escapeHtml(userNameMap[t.userId] || t.userId)}</td>
            <td>${escapeHtml(t.name)}</td>
            <td style="font-size:0.75rem;">${rangeStr}</td>
            <td style="font-size:0.7rem;">${daysStr}</td>
            <td>
                <button class="btn btn-sm btn-danger" onclick="deleteTask('${t.id}')"><i class="bi bi-trash"></i></button>
            </td>
        </tr>`;
    }).join('');
    $('#tasksTable').html(html);

    // Set today as default start date
    if (!$('#taskStartDate').val()) {
        $('#taskStartDate').val(new Date().toISOString().slice(0, 10));
    }
}

async function addTask() {
    const name = $('#taskName').val().trim();
    const color = $('#taskColor').val();
    const userId = $('#taskUserId').val();
    const startDate = $('#taskStartDate').val();
    const endDate = $('#taskEndDate').val() || null;
    const daysOfWeek = [];
    $('#taskDaysPicker .dow-pick.selected').each(function() {
        daysOfWeek.push(parseInt($(this).data('day')));
    });

    if (!name) { Swal.fire('تنبيه', 'يرجى إدخال اسم المهمة', 'warning'); return; }
    if (!userId) { Swal.fire('تنبيه', 'يرجى اختيار مستخدم', 'warning'); return; }
    if (!startDate) { Swal.fire('تنبيه', 'يرجى تحديد تاريخ البداية', 'warning'); return; }
    if (daysOfWeek.length === 0) { Swal.fire('تنبيه', 'يرجى اختيار يوم واحد على الأقل', 'warning'); return; }

    requirePinForAction(function() {
        const id = 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        const taskData = {
            name, color, userId, startDate, endDate, daysOfWeek, createdAt: Date.now()
        };
        tasksNode.get(id).put(taskData);
        localTasks[id] = taskData;
        saveToLocal();
        if (typeof broadcastCurrentData === 'function') broadcastCurrentData();

        // Reset form
        $('#taskName').val('');
        $('#taskDaysPicker .dow-pick').removeClass('selected');

        loadTasks();
        if (typeof renderCalendar === 'function') renderCalendar();
        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'تم إضافة المهمة', showConfirmButton: false, timer: 1500 });
    });
}

async function deleteTask(id) {
    const result = await Swal.fire({ title: 'تأكيد الحذف', text: 'هل أنت متأكد من حذف هذه المهمة؟', icon: 'warning', showCancelButton: true, confirmButtonText: 'نعم، احذف', cancelButtonText: 'إلغاء' });
    if (!result.isConfirmed) return;

    requirePinForAction(function() {
        tasksNode.get(id).put(null);
        delete localTasks[id];
        saveToLocal();
        if (typeof broadcastCurrentData === 'function') broadcastCurrentData();
        loadTasks();
        if (typeof renderCalendar === 'function') renderCalendar();
        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'تم حذف المهمة', showConfirmButton: false, timer: 1500 });
    });
}

// ==================== EVENT MANAGEMENT (no PIN required) ====================

function loadEvents() {
    const users = Object.entries(localUsers).map(([id, u]) => ({ id, ...u }));
    const userNameMap = {};
    users.forEach(u => { userNameMap[u.id] = u.name; });

    const events = Object.entries(localEvents).map(([id, e]) => ({ id, ...e }));
    const REPEAT_NAMES = { none: 'بدون', daily: 'يومي', weekly: 'أسبوعي', monthly: 'شهري', yearly: 'سنوي' };

    const html = events.map(e => {
        const userNames = (e.userIds || []).map(uid => escapeHtml(userNameMap[uid] || uid)).join('، ') || '—';
        const repeatStr = REPEAT_NAMES[e.repeat || 'none'] || 'بدون';
        return `<tr>
            <td>${escapeHtml(e.name)}</td>
            <td style="font-size:0.75rem;">${e.date || '—'} ${e.time ? e.time : ''}</td>
            <td>${userNames}</td>
            <td>${repeatStr}</td>
            <td>
                <button class="btn btn-sm btn-danger" onclick="deleteEvent('${e.id}')"><i class="bi bi-trash"></i></button>
            </td>
        </tr>`;
    }).join('');
    $('#eventsTable').html(html);

    // Set today as default date
    if (!$('#eventDate').val()) {
        $('#eventDate').val(new Date().toISOString().slice(0, 10));
    }

    // Populate event user picker
    populateEventUserPicker();
}

function populateEventUserPicker() {
    const users = Object.entries(localUsers).map(([id, u]) => ({ id, ...u }));
    const picker = $('#eventUserPicker');
    picker.empty();
    users.forEach(u => {
        const initial = u.name ? u.name.charAt(0) : '?';
        picker.append(`<button class="user-multi-pick-btn" data-userid="${u.id}" onclick="$(this).toggleClass('selected')">
            <span class="up-av" style="background:${u.color || '#6366f1'}">${escapeHtml(initial)}</span> ${escapeHtml(u.name)}
        </button>`);
    });
}

function openEventForm() {
    populateEventUserPicker();
    if (!$('#eventDate').val()) {
        $('#eventDate').val(new Date().toISOString().slice(0, 10));
    }
    $('#eventModal').addClass('open');
}

function closeEventForm() {
    $('#eventModal').removeClass('open');
    $('#eventName').val('');
    $('#eventTime').val('');
    $('#eventRepeat').val('none');
    $('#eventRepeatEnd').val('');
    $('#eventRepeatEndGroup').hide();
    $('#eventUserPicker .user-multi-pick-btn').removeClass('selected');
}

function toggleEventRepeatEnd() {
    const repeat = $('#eventRepeat').val();
    $('#eventRepeatEndGroup').toggle(repeat !== 'none');
}

function saveEvent() {
    const name = $('#eventName').val().trim();
    const date = $('#eventDate').val();
    const time = $('#eventTime').val() || null;
    const repeat = $('#eventRepeat').val();
    const repeatEnd = $('#eventRepeatEnd').val() || null;
    const color = $('#eventColor').val();
    const userIds = [];
    $('#eventUserPicker .user-multi-pick-btn.selected').each(function() {
        userIds.push($(this).data('userid'));
    });

    if (!name) { Swal.fire('تنبيه', 'يرجى إدخال اسم المناسبة', 'warning'); return; }
    if (!date) { Swal.fire('تنبيه', 'يرجى تحديد التاريخ', 'warning'); return; }

    const id = 'event_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    const eventData = {
        name, date, time, userIds, repeat, repeatEnd, color, createdAt: Date.now()
    };
    eventsNode.get(id).put(eventData);
    localEvents[id] = eventData;
    saveToLocal();
    if (typeof broadcastCurrentData === 'function') broadcastCurrentData();

    closeEventForm();
    loadEvents();
    if (typeof renderCalendar === 'function') renderCalendar();
    Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'تم إضافة المناسبة', showConfirmButton: false, timer: 1500 });
}

async function deleteEvent(id) {
    const result = await Swal.fire({ title: 'تأكيد الحذف', text: 'هل أنت متأكد من حذف هذه المناسبة؟', icon: 'warning', showCancelButton: true, confirmButtonText: 'نعم، احذف', cancelButtonText: 'إلغاء' });
    if (!result.isConfirmed) return;

    eventsNode.get(id).put(null);
    delete localEvents[id];
    saveToLocal();
    if (typeof broadcastCurrentData === 'function') broadcastCurrentData();
    loadEvents();
    if (typeof renderCalendar === 'function') renderCalendar();
    Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'تم حذف المناسبة', showConfirmButton: false, timer: 1500 });
}

// Data reset — ALWAYS requires PIN (no grace period)
async function resetData() {
    const result = await Swal.fire({
        title: 'تأكيد إعادة التعيين',
        text: 'سيتم حذف جميع التقييمات. المهام والمستخدمين سيبقون.',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'نعم، إعادة تعيين',
        cancelButtonText: 'إلغاء'
    });
    if (!result.isConfirmed) return;

    await requirePinAlways(async function() {
        completionsNode.map().once((data, id) => { if (data) completionsNode.get(id).put(null); });
        localCompletions = {};
        saveToLocal();
        if (typeof broadcastCurrentData === 'function') broadcastCurrentData();
        if (typeof renderCalendar === 'function') renderCalendar();
        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'تم إعادة التعيين', showConfirmButton: false, timer: 1500 });
    });
}

// ==================== EXPORT / IMPORT ====================

function exportData() {
    requirePinForAction(function() {
        try {
            const exportObj = {
                version: 'v7',
                exportedAt: new Date().toISOString(),
                familyCode: familyCode,
                familyName: familyName || sessionStorage.getItem('familyName') || '',
                deviceName: (typeof P2P !== 'undefined' ? P2P.getDeviceName() : '') || '',
                data: {
                    users: localUsers || {},
                    tasks: localTasks || {},
                    completions: localCompletions || {},
                    events: localEvents || {}
                },
                settings: {}
            };

            // Include room ID for full backup
            if (typeof P2P !== 'undefined') {
                const roomId = P2P.getStoredRoomId(familyCode);
                if (roomId) exportObj.roomId = roomId;
            }

            // Include approved tokens for full backup
            if (typeof P2P !== 'undefined') {
                const tokens = P2P.getApprovedTokens();
                if (Object.keys(tokens).length > 0) exportObj.approvedTokens = tokens;
            }

            // Include approval token (this device's token for reconnection)
            if (typeof P2P !== 'undefined') {
                const approvalToken = P2P.getStoredApprovalToken();
                if (approvalToken) exportObj.approvalToken = approvalToken;
            }

            // Try to get settings from Gun.js
            family.get('settings').once((settings) => {
                if (settings) {
                    exportObj.settings = {
                        pinGracePeriod: settings.pinGracePeriod || 1,
                        startDate: settings.startDate || null
                    };
                }

                const json = JSON.stringify(exportObj, null, 2);
                const blob = new Blob([json], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                const dateStr = new Date().toISOString().slice(0, 10);
                a.download = `task-schedule-${familyCode}-${dateStr}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'تم تصدير البيانات بنجاح', showConfirmButton: false, timer: 2000 });
            });
        } catch (e) {
            console.error('[Export] Failed:', e);
            Swal.fire('خطأ', 'فشل تصدير البيانات', 'error');
        }
    });
}

function importData(event) {
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = '';

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const imported = JSON.parse(e.target.result);

            // Validate structure
            if (!imported.familyCode || !imported.data) {
                Swal.fire('خطأ', 'ملف غير صالح — يجب أن يحتوي على familyCode و data', 'error');
                return;
            }
            if (!imported.data.users && !imported.data.tasks && !imported.data.completions) {
                Swal.fire('خطأ', 'ملف لا يحتوي على بيانات مستخدمين أو مهام', 'error');
                return;
            }

            requirePinForAction(async function() {
                const result = await Swal.fire({
                    title: 'تأكيد الاستيراد',
                    html: `<p>سيتم <strong>استبدال</strong> جميع البيانات الحالية بالمستوردة.</p>
                           <p class="text-muted"><small>العائلة: ${escapeHtml(imported.familyCode)}</small></p>
                           <p class="text-muted"><small>المستخدمين: ${Object.keys(imported.data.users || {}).length} | المهام: ${Object.keys(imported.data.tasks || {}).length}</small></p>`,
                    icon: 'warning',
                    showCancelButton: true,
                    confirmButtonText: 'نعم، استورد البيانات',
                    cancelButtonText: 'إلغاء',
                    confirmButtonColor: '#ef4444'
                });

                if (!result.isConfirmed) return;

                // Overwrite localStorage data
                const storageKey = 'taskSchedule_' + imported.familyCode;
                const dataToStore = {
                    users: imported.data.users || {},
                    tasks: imported.data.tasks || {},
                    completions: imported.data.completions || {},
                    events: imported.data.events || {},
                    timestamp: Date.now()
                };
                localStorage.setItem(storageKey, JSON.stringify(dataToStore));

                // Update Gun.js nodes
                if (imported.data.users) {
                    Object.entries(imported.data.users).forEach(([id, userData]) => {
                        usersNode.get(id).put(userData);
                    });
                }
                if (imported.data.tasks) {
                    Object.entries(imported.data.tasks).forEach(([id, taskData]) => {
                        tasksNode.get(id).put(taskData);
                    });
                }
                if (imported.data.completions) {
                    Object.entries(imported.data.completions).forEach(([id, compData]) => {
                        completionsNode.get(id).put(compData);
                    });
                }

                // Import settings
                if (imported.settings) {
                    family.get('settings').put(imported.settings);
                }

                // Import room ID
                if (imported.roomId && typeof P2P !== 'undefined') {
                    P2P.storeRoomId(imported.familyCode, imported.roomId);
                }

                // Import approved tokens
                if (imported.approvedTokens && typeof P2P !== 'undefined') {
                    localStorage.setItem(P2P.APPROVED_TOKENS_KEY, JSON.stringify(imported.approvedTokens));
                }

                // Import approval token (this device's token)
                if (imported.approvalToken && typeof P2P !== 'undefined') {
                    P2P.storeApprovalToken(imported.approvalToken);
                }

                // Import device name
                if (imported.deviceName && typeof P2P !== 'undefined') {
                    P2P.setDeviceName(imported.deviceName);
                }

                // Import events
                if (imported.data.events) {
                    Object.entries(imported.data.events).forEach(([id, eventData]) => {
                        eventsNode.get(id).put(eventData);
                    });
                }

                // Update in-memory caches
                if (imported.data.users) localUsers = imported.data.users;
                if (imported.data.tasks) localTasks = imported.data.tasks;
                if (imported.data.completions) localCompletions = imported.data.completions;
                if (imported.data.events) localEvents = imported.data.events;

                // Broadcast to peers
                if (typeof broadcastCurrentData === 'function') broadcastCurrentData();

                Swal.fire({
                    icon: 'success',
                    title: 'تم الاستيراد بنجاح',
                    text: 'سيتم إعادة تحميل الصفحة لتطبيق البيانات.',
                    confirmButtonText: 'حسناً'
                }).then(() => {
                    location.reload();
                });
            });
        } catch (err) {
            console.error('[Import] Failed:', err);
            Swal.fire('خطأ', 'فشل قراءة الملف — تأكد أنه ملف JSON صالح', 'error');
        }
    };
    reader.readAsText(file);
}

// ==================== PIN HELPERS ====================

// Require PIN for settings actions (uses grace period, refreshes timer)
async function requirePinForAction(callback) {
    const now = Date.now();
    if (lastPinVerification && (now - lastPinVerification) < pinGracePeriod) {
        lastPinVerification = Date.now();
        await callback();
        return;
    }

    const allUsers = Object.entries(localUsers).map(([id, u]) => ({ id, ...u }));
    if (allUsers.length === 0) { await callback(); return; }

    const usersWithPins = allUsers.filter(u => u.pinHash);
    if (usersWithPins.length === 0) { await callback(); return; }

    const inputOptions = {};
    allUsers.forEach(u => { inputOptions[u.id] = u.name; });

    const { value: formValues } = await Swal.fire({
        title: '<i class="bi bi-shield-lock"></i> تحقق للإجراء',
        input: 'select',
        inputOptions: inputOptions,
        inputPlaceholder: 'اختر المستخدم',
        showCancelButton: true,
        confirmButtonText: 'متابعة',
        cancelButtonText: 'إلغاء',
        inputValidator: (value) => { if (!value) return 'يرجى اختيار مستخدم'; }
    });

    if (!formValues) return;

    const selectedUser = localUsers[formValues];
    if (!selectedUser || !selectedUser.pinHash) {
        lastPinVerification = Date.now();
        await callback();
        return;
    }

    const { value: pin } = await Swal.fire({
        title: `<i class="bi bi-person-fill"></i> ${escapeHtml(selectedUser.name)}`,
        input: 'password',
        inputPlaceholder: '••••',
        inputAttributes: { maxlength: 6, inputmode: 'numeric', pattern: '[0-9]*', style: 'text-align:center;font-size:28px;letter-spacing:12px;' },
        showCancelButton: true,
        confirmButtonText: 'تأكيد',
        cancelButtonText: 'إلغاء',
        showLoaderOnConfirm: true,
        allowOutsideClick: () => !Swal.isLoading(),
        preConfirm: async (p) => {
            if (!p) { Swal.showValidationMessage('يرجى إدخال الرمز'); return false; }
            const pinHash = await hashPin(p);
            if (pinHash !== selectedUser.pinHash) { Swal.showValidationMessage('الرمز غير صحيح'); return false; }
            return p;
        }
    });

    if (pin) {
        lastPinVerification = Date.now();
        await callback();
    }
}

// Require PIN ALWAYS (no grace period) — for destructive actions like reset
async function requirePinAlways(callback) {
    const allUsers = Object.entries(localUsers).map(([id, u]) => ({ id, ...u }));
    if (allUsers.length === 0) { await callback(); return; }

    const usersWithPins = allUsers.filter(u => u.pinHash);
    if (usersWithPins.length === 0) { await callback(); return; }

    const inputOptions = {};
    allUsers.forEach(u => { inputOptions[u.id] = u.name; });

    const { value: formValues } = await Swal.fire({
        title: '<i class="bi bi-exclamation-triangle text-danger"></i> تأكيد الهوية',
        html: '<p class="text-danger">هذا الإجراء يتطلب تأكيد الهوية دائماً</p>',
        input: 'select',
        inputOptions: inputOptions,
        inputPlaceholder: 'اختر المستخدم',
        showCancelButton: true,
        confirmButtonText: 'متابعة',
        cancelButtonText: 'إلغاء',
        inputValidator: (value) => { if (!value) return 'يرجى اختيار مستخدم'; }
    });

    if (!formValues) return;

    const selectedUser = localUsers[formValues];
    if (!selectedUser || !selectedUser.pinHash) {
        await callback();
        return;
    }

    const { value: pin } = await Swal.fire({
        title: `<i class="bi bi-person-fill"></i> ${escapeHtml(selectedUser.name)}`,
        html: '<p class="text-muted">أدخل الرمز الشخصي للتأكيد</p>',
        input: 'password',
        inputPlaceholder: '••••',
        inputAttributes: { maxlength: 6, inputmode: 'numeric', pattern: '[0-9]*', style: 'text-align:center;font-size:28px;letter-spacing:12px;' },
        showCancelButton: true,
        confirmButtonText: 'تأكيد',
        cancelButtonText: 'إلغاء',
        showLoaderOnConfirm: true,
        allowOutsideClick: () => !Swal.isLoading(),
        preConfirm: async (p) => {
            if (!p) { Swal.showValidationMessage('يرجى إدخال الرمز'); return false; }
            const pinHash = await hashPin(p);
            if (pinHash !== selectedUser.pinHash) { Swal.showValidationMessage('الرمز غير صحيح'); return false; }
            return p;
        }
    });

    if (pin) {
        await callback();
    }
}