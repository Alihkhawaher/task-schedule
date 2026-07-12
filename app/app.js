// Task Schedule App - V6 (P2P with Gun.js)
// No server needed — data syncs peer-to-peer

// Config
const APP_CONFIG = {
    rewards: { week: 100, month: 500 },
    punishments: [
        { threshold: 5, description: 'منع استخدام الهاتف' },
        { threshold: 35, description: 'منع مشاهدة التلفاز' },
        { threshold: 50, description: 'منع الخروج من المنزل' }
    ]
};

// Load reward/punishment config from localStorage
function loadRewardConfig() {
    try {
        const raw = localStorage.getItem('taskSchedule_rewardConfig_' + familyCode);
        if (raw) {
            const cfg = JSON.parse(raw);
            if (cfg.rewards) APP_CONFIG.rewards = cfg.rewards;
            if (cfg.punishments) APP_CONFIG.punishments = cfg.punishments;
        }
    } catch (e) {}
}

function saveRewardConfig() {
    try {
        localStorage.setItem('taskSchedule_rewardConfig_' + familyCode, JSON.stringify({
            rewards: APP_CONFIG.rewards,
            punishments: APP_CONFIG.punishments
        }));
    } catch (e) {}
}

// Auth check — restore session from localStorage if sessionStorage is empty
let familyCode = sessionStorage.getItem('familyCode');
let memberName = sessionStorage.getItem('memberName');
let familyName = sessionStorage.getItem('familyName');

if (!familyCode) {
    // Try to restore from localStorage (PWA install, new tab, etc.)
    const storedData = localStorage.getItem('taskSchedule_lastSession');
    if (storedData) {
        try {
            const session = JSON.parse(storedData);
            // Check session expiry (30 days)
            const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days in ms
            if (session.familyCode && session.memberName && session.timestamp && (Date.now() - session.timestamp) < maxAge) {
                sessionStorage.setItem('familyCode', session.familyCode);
                sessionStorage.setItem('memberName', session.memberName);
                sessionStorage.setItem('familyName', session.familyName || '');
                familyCode = session.familyCode;
                memberName = session.memberName;
                familyName = session.familyName || '';
            } else if (session.familyCode && session.memberName && !session.timestamp) {
                // Legacy session without timestamp — restore but add timestamp
                sessionStorage.setItem('familyCode', session.familyCode);
                sessionStorage.setItem('memberName', session.memberName);
                sessionStorage.setItem('familyName', session.familyName || '');
                familyCode = session.familyCode;
                memberName = session.memberName;
                familyName = session.familyName || '';
            }
        } catch (e) {
            console.warn('[App] Failed to restore session from localStorage:', e);
        }
    }
}

if (!familyCode) { window.location.href = '../index.html'; }

// Save session to localStorage for PWA persistence (works for any login path)
if (familyCode && memberName) {
    try {
        localStorage.setItem('taskSchedule_lastSession', JSON.stringify({
            familyCode: familyCode,
            memberName: memberName,
            familyName: familyName || '',
            timestamp: Date.now()
        }));
    } catch (e) {}
}

// Simple hash function (same as login page)
async function hashPin(pin) {
    const encoder = new TextEncoder();
    const data = encoder.encode(pin + 'task-schedule-salt');
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Gun.js setup — local only (no external peers, Trystero handles P2P sync)
const gun = Gun({ peers: [], localStorage: true });
const family = gun.get('families').get(familyCode);
const usersNode = family.get('members');
const tasksNode = family.get('tasks');
const completionsNode = family.get('completions');

// Local caches
let localUsers = {};
let localTasks = {};
let localCompletions = {};

// ==================== LOCALSTORAGE PERSISTENCE ====================
// Backup layer: saves/loads data from localStorage so data survives logout/login
// even when Gun.js relay servers are down
const STORAGE_KEY = 'taskSchedule_' + familyCode;

function saveToLocal() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            users: localUsers,
            tasks: localTasks,
            completions: localCompletions,
            timestamp: Date.now()
        }));
    } catch (e) { console.warn('localStorage save failed:', e); }
}

function loadFromLocal() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const data = JSON.parse(raw);
            if (data.users) localUsers = data.users;
            if (data.tasks) localTasks = data.tasks;
            if (data.completions) localCompletions = data.completions;
            return true;
        }
    } catch (e) { console.warn('localStorage load failed:', e); }
    return false;
}
let currentMonth = new Date().getMonth();
let currentYear = new Date().getFullYear();
let progressChart = null;

// PIN grace period (default 1 minute, configurable in settings)
let pinGracePeriod = 60 * 1000; // 1 minute in ms
let lastPinVerification = 0; // timestamp of last successful PIN entry

// Start date for scheduler (null = no start date restriction)
let schedulerStartDate = null;

// Arabic day names
const DAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

// Helpers
function escapeHtml(t) { if (!t) return ''; const d = document.createElement('div'); d.textContent = String(t); return d.innerHTML; }
function dateKey(year, month, day) { return `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`; }
function isLight(color) { const h = color.replace('#',''); const r = parseInt(h.substr(0,2),16), g = parseInt(h.substr(2,2),16), b = parseInt(h.substr(4,2),16); return ((r*299)+(g*587)+(b*114))/1000 > 155; }

// Init
$(document).ready(function() {
    moment.locale('ar');
    const cy = new Date().getFullYear();
    for (let y = cy - 2; y <= cy + 2; y++) $('#yearSelect').append(`<option value="${y}" ${y===cy?'selected':''}>${y}</option>`);
    $('#monthSelect').val(new Date().getMonth());

    // Load from localStorage first (instant, no network needed)
    loadFromLocal();
    loadRewardConfig();

    // Listen for Gun.js data changes (P2P sync) — also saves to localStorage
    family.get('members').map().on((data, id) => { if (data && data.name) { localUsers[id] = data; saveToLocal(); } });
    tasksNode.map().on((data, id) => { if (data && data.name) { localTasks[id] = data; saveToLocal(); } });
    completionsNode.map().on((data, id) => { if (data) { localCompletions[id] = data; saveToLocal(); } });

    // Load family settings (grace period, start date)
    family.get('settings').once((settings) => {
        if (settings) {
            if (settings.pinGracePeriod) pinGracePeriod = settings.pinGracePeriod * 60 * 1000;
            if (settings.startDate) schedulerStartDate = settings.startDate;
        }
    });

    // Render UI: first from localStorage (instant), then after Gun.js sync
    const renderUI = () => {
        initializeUI();
        loadTaskTable();
        updateStatistics();
        initializeChart();
    };
    setTimeout(renderUI, 200);   // Fast render from localStorage
    setTimeout(renderUI, 2000);  // Re-render after Gun.js/P2P data arrives

    $('#monthSelect').change(function() { currentMonth = parseInt($(this).val()); loadTaskTable(); updateStatistics(); updateChart(); });
    $('#yearSelect').change(function() { currentYear = parseInt($(this).val()); loadTaskTable(); updateStatistics(); updateChart(); });

    // Settings overlay
    $('#btnOpenSettings').click(function() { openSettings(); });
    $('#btnCloseSettings').click(function() { closeSettings(); });
    $('#settingsBackdrop').click(function() { closeSettings(); });
});

function initializeUI() {
    createTaskLegend();
}

function createTaskLegend() {
    const tasks = Object.values(localTasks);
    const html = tasks.map(t => `<div class="legend-item" style="background-color:${t.color};color:${isLight(t.color)?'#2c3e50':'white'};"><div class="legend-color" style="width:12px;height:12px;background-color:${t.color};border-radius:50%;border:2px solid rgba(255,255,255,0.3);"></div>${escapeHtml(t.name)}</div>`).join('');
    $('#taskLegend').html(html);
}

// Load task table
async function loadTaskTable() {
    const users = Object.entries(localUsers).map(([id, u]) => ({ id, ...u }));
    const tasks = Object.values(localTasks);
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();

    let headerHtml = '<tr><th class="date-cell">التاريخ</th>';
    users.forEach(u => { headerHtml += `<th class="name-header">${escapeHtml(u.name)}</th>`; });
    headerHtml += '</tr>';
    $('#taskTable thead').html(headerHtml);

    let bodyHtml = '', week = 1;
    for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(currentYear, currentMonth, day);
        const wk = getWeekNumber(date);
        const dayOfWeek = date.getDay(); // 0=Sun, 6=Sat
        const dayName = DAY_NAMES[dayOfWeek];

        if (day === 1 || (day > 1 && getWeekNumber(new Date(currentYear, currentMonth, day-1)) !== wk)) {
            bodyHtml += `<tr><td colspan="${1+users.length}" class="week-header">الأسبوع ${week}</td></tr>`;
            week++;
        }
        const dk = dateKey(currentYear, currentMonth, day);
        const isToday = day === new Date().getDate() && currentMonth === new Date().getMonth() && currentYear === new Date().getFullYear();

        // Check if this day is before the start date
        const isBeforeStart = schedulerStartDate && dk < schedulerStartDate;

        bodyHtml += `<tr class="${isToday?'current-day':''}"><td class="date-col-cell"><div class="date-cell-wrap"><span class="date-num">${day}</span><span class="date-name">${dayName}</span></div></td>`;
        for (const u of users) {
            if (isBeforeStart) {
                bodyHtml += `<td class="status-cell before-start" data-user-id="${u.id}" data-user-name="${escapeHtml(u.name)}" data-date="${dk}">—</td>`;
            } else {
                const rate = getDailyCompletion(u.id, dk, tasks.length);
                bodyHtml += `<td class="status-cell ${getCellClass(rate)}" data-user-id="${u.id}" data-user-name="${escapeHtml(u.name)}" data-date="${dk}">${getStatusSvg(rate)}</td>`;
            }
        }
        bodyHtml += '</tr>';
    }
    $('#taskTable tbody').html(bodyHtml);

    $('.status-cell').click(function() {
        if ($(this).hasClass('before-start')) return;
        const uid = $(this).data('userId'), uname = $(this).data('userName'), date = $(this).data('date');
        promptPinAndOpen(uid, uname, date);
    });
    scrollToCurrentDay();
}

function getDailyCompletion(userId, date, totalTasks) {
    if (totalTasks === 0) return 0;
    let count = 0;
    Object.values(localCompletions).forEach(c => {
        if (c.userId === userId && c.date === date && c.completed === true) count++;
    });
    return (count / totalTasks) * 100;
}

function getStatusSvg(pct) {
    if (pct === 100) return '<svg width="32" height="32" viewBox="0 0 22 22"><circle cx="11" cy="11" r="10" fill="#10b981"/><path d="M7 11l3 3 5-5" stroke="white" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    if (pct >= 80) return '<svg width="32" height="32" viewBox="0 0 22 22"><circle cx="11" cy="11" r="10" fill="#34d399"/><circle cx="11" cy="11" r="6" fill="white"/><circle cx="11" cy="11" r="3" fill="#34d399"/></svg>';
    if (pct >= 60) return '<svg width="32" height="32" viewBox="0 0 22 22"><circle cx="11" cy="11" r="10" fill="#fbbf24"/><path d="M11 5 A6 6 0 0 1 11 17" fill="white" opacity="0.5"/><circle cx="11" cy="11" r="3" fill="white"/></svg>';
    if (pct >= 40) return '<svg width="32" height="32" viewBox="0 0 22 22"><circle cx="11" cy="11" r="10" fill="#f97316" opacity="0.8"/><circle cx="11" cy="11" r="7" fill="white" opacity="0.4"/><circle cx="11" cy="11" r="4" fill="#f97316"/></svg>';
    if (pct > 0) return '<svg width="32" height="32" viewBox="0 0 22 22"><circle cx="11" cy="11" r="10" fill="#ef4444" opacity="0.6"/><circle cx="11" cy="11" r="10" fill="none" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="4 3"/></svg>';
    return '<svg width="32" height="32" viewBox="0 0 22 22"><circle cx="11" cy="11" r="10" fill="none" stroke="#cbd5e1" stroke-width="1.5" stroke-dasharray="3 3"/><circle cx="11" cy="11" r="3" fill="#e2e8f0"/></svg>';
}
function getCellClass(pct) {
    if (pct === 100) return 'cell-100';
    if (pct >= 80) return 'cell-80';
    if (pct >= 60) return 'cell-60';
    if (pct >= 40) return 'cell-40';
    if (pct > 0) return 'cell-20';
    return 'cell-0';
}

// PIN-based check-in with grace period
async function promptPinAndOpen(userId, userName, date) {
    const user = localUsers[userId];
    if (!user || !user.pinHash) { openTaskModal(userId, userName, date); return; }

    // Grace period: skip PIN if recently verified
    const now = Date.now();
    if (lastPinVerification && (now - lastPinVerification) < pinGracePeriod) {
        lastPinVerification = Date.now(); // Refresh timer
        openTaskModal(userId, userName, date);
        return;
    }

    const { value: pin } = await Swal.fire({
        title: `<i class="bi bi-person-fill"></i> ${escapeHtml(userName)}`,
        html: '<p class="text-muted mb-3">أدخل الرمز الشخصي للتحقق</p>',
        input: 'password', inputPlaceholder: '••••',
        inputAttributes: { maxlength: 6, inputmode: 'numeric', pattern: '[0-9]*', style: 'text-align:center;font-size:28px;letter-spacing:12px;' },
        showCancelButton: true, confirmButtonText: 'تأكيد', cancelButtonText: 'إلغاء',
        showLoaderOnConfirm: true, allowOutsideClick: () => !Swal.isLoading(),
        preConfirm: async (p) => {
            if (!p) { Swal.showValidationMessage('يرجى إدخال الرمز'); return false; }
            const pinHash = await hashPin(p);
            if (pinHash !== user.pinHash) { Swal.showValidationMessage('الرمز غير صحيح'); return false; }
            return p;
        }
    });
    if (pin) {
        lastPinVerification = Date.now(); // Record for grace period
        openTaskModal(userId, userName, date);
    }
}

function openTaskModal(userId, userName, date) {
    const tasks = Object.entries(localTasks).map(([id, t]) => ({ id, ...t }));
    const completions = Object.values(localCompletions).filter(c => c.userId === userId && c.date === date);

    $('#modalDate').text(moment(date).format('LL'));
    $('#modalUser').text(userName);
    const list = $('#modalTaskList');
    list.empty();

    tasks.forEach(task => {
        const done = completions.some(c => c.taskId === task.id && c.completed);
        list.append(`<li class="list-group-item d-flex justify-content-between align-items-center">
            <div><input class="form-check-input me-2" type="checkbox" data-task-id="${task.id}" data-user-id="${userId}" data-date="${date}" ${done?'checked':''}>
            <label>${escapeHtml(task.name)}</label></div>
            <span class="task-color-preview" style="background-color:${escapeHtml(task.color)};"></span></li>`);
    });

    $('#taskCompletionModal').modal('show');
    $('#modalTaskList .form-check-input').change(function() { toggleCompletion($(this)); });
}

function toggleCompletion($cb) {
    const taskId = $cb.data('taskId'), userId = $cb.data('userId'), date = $cb.data('date'), checked = $cb.is(':checked');
    const cid = `${userId}_${date}_${taskId}`;

    if (checked) {
        completionsNode.get(cid).put({ userId, taskId, date, completed: true, timestamp: Date.now() });
    } else {
        completionsNode.get(cid).put({ userId, taskId, date, completed: false, timestamp: Date.now() });
    }

    // Update local cache and persist
    localCompletions[cid] = { userId, taskId, date, completed: checked, timestamp: Date.now() };
    saveToLocal();

    // Broadcast to connected peers
    broadcastCurrentData();

    // Update emoji
    const tasks = Object.values(localTasks);
    const rate = getDailyCompletion(userId, date, tasks.length);
    $(`.status-cell[data-user-id="${userId}"][data-date="${date}"]`).html(getStatusSvg(rate)).attr('class', 'status-cell ' + getCellClass(rate));
    updateStatistics();
    updateChart();
}

// Statistics
async function updateStatistics() {
    const users = Object.entries(localUsers).map(([id, u]) => ({ id, ...u }));
    let totalRewards = 0, activePunishments = 0, totalCompletion = 0;
    const today = new Date(), cmv = today.getMonth(), cyv = today.getFullYear(), cd = today.getDate();

    for (const u of users) {
        const mr = calcCompletionRate(u.id, currentMonth, currentYear);
        totalCompletion += mr;
        totalRewards += calcWeeklyRewards(u.id, currentMonth, currentYear) + (mr === 100 ? APP_CONFIG.rewards.month : 0);

        if (currentYear < cyv || (currentYear === cyv && currentMonth < cmv)) {
            const weeks = getWeeksInMonth(currentYear, currentMonth);
            for (let w = 1; w <= weeks; w++) { if (calcWeekRate(u.id, w, currentMonth, currentYear) < 50) activePunishments++; }
        } else if (currentYear === cyv && currentMonth === cmv) {
            const cw = getWeekNumber(today);
            if (cw > 1 && calcWeekRate(u.id, cw - 1, currentMonth, currentYear) < 50) activePunishments++;
        }
    }

    const avg = users.length > 0 ? Math.round(totalCompletion / users.length) : 0;
    $('#totalRewards').text(`${totalRewards} ريال`);
    $('#activePunishments').text(activePunishments);
    $('#averageCompletion').text(`${avg}%`);
    $('#currentWeek').text(getWeekNumber(today));
    // Also update statistics modal
    $('#modalTotalRewards').text(`${totalRewards} ريال`);
    $('#modalActivePunishments').text(activePunishments);
    $('#modalAverageCompletion').text(`${avg}%`);
    $('#modalCurrentWeek').text(getWeekNumber(today));
}

function calcCompletionRate(userId, month, year) {
    const tasks = Object.values(localTasks);
    if (tasks.length === 0) return 0;
    let count = 0;
    Object.values(localCompletions).forEach(c => {
        if (c.userId === userId && c.completed === true) {
            const d = new Date(c.date);
            if (d.getMonth() === month && d.getFullYear() === year) count++;
        }
    });
    const today = new Date();
    let daysPassed;
    if (year === today.getFullYear() && month === today.getMonth()) daysPassed = today.getDate();
    else if (year < today.getFullYear() || (year === today.getFullYear() && month < today.getMonth())) daysPassed = new Date(year, month + 1, 0).getDate();
    else return 0;

    // Respect start date — subtract days before start
    if (schedulerStartDate) {
        const startDk = dateKey(year, month, 1);
        const endDk = dateKey(year, month, daysPassed);
        if (endDk < schedulerStartDate) return 0; // Entire month before start
        if (startDk < schedulerStartDate) {
            const sd = new Date(schedulerStartDate);
            if (sd.getFullYear() === year && sd.getMonth() === month) {
                daysPassed = daysPassed - (sd.getDate() - 1);
            }
        }
    }

    const total = daysPassed * tasks.length;
    return total > 0 ? Math.round((count / total) * 100) : 0;
}

function calcWeekRate(userId, week, month, year) {
    const tasks = Object.values(localTasks);
    if (tasks.length === 0) return 0;
    let count = 0;
    Object.values(localCompletions).forEach(c => {
        if (c.userId === userId && c.completed === true && getWeekNumber(new Date(c.date)) === week) {
            const d = new Date(c.date);
            if (d.getMonth() === month && d.getFullYear() === year) count++;
        }
    });
    const total = 7 * tasks.length;
    return total > 0 ? Math.round((count / total) * 100) : 0;
}

function calcWeeklyRewards(userId, month, year) {
    const tasks = Object.values(localTasks);
    if (tasks.length === 0) return 0;
    let rewards = 0;
    const weeks = getWeeksInMonth(year, month);
    for (let w = 1; w <= weeks; w++) {
        let count = 0;
        Object.values(localCompletions).forEach(c => {
            if (c.userId === userId && c.completed === true && getWeekNumber(new Date(c.date)) === w) {
                const d = new Date(c.date);
                if (d.getMonth() === month && d.getFullYear() === year) count++;
            }
        });
        const daysInWeek = getDaysInWeekOfMonth(w, month, year);
        const total = daysInWeek * tasks.length;
        if (total > 0 && Math.round((count / total) * 100) === 100) rewards += APP_CONFIG.rewards.week;
    }
    return rewards;
}

// Rewards & Punishments tables
function showRewards() {
    const users = Object.entries(localUsers).map(([id, u]) => ({ id, ...u }));
    let html = '';
    users.forEach(u => {
        const mr = calcCompletionRate(u.id, currentMonth, currentYear);
        const wr = calcWeeklyRewards(u.id, currentMonth, currentYear);
        const total = wr + (mr === 100 ? APP_CONFIG.rewards.month : 0);
        if (total > 0) html += `<tr><td>${escapeHtml(u.name)}</td><td>شهري</td><td>${mr}%</td><td>${total} ريال</td></tr>`;
    });
    $('#rewardsTableBody').html(html || '<tr><td colspan="4" class="text-center">لا توجد مكافآت</td></tr>');
    $('#rewardsModal').modal('show');
}

function showPunishments() {
    const users = Object.entries(localUsers).map(([id, u]) => ({ id, ...u }));
    const today = new Date();
    const isFuture = currentYear > today.getFullYear() || (currentYear === today.getFullYear() && currentMonth > today.getMonth());
    let html = '';
    if (!isFuture) {
        users.forEach(u => {
            const mr = calcCompletionRate(u.id, currentMonth, currentYear);
            const p = APP_CONFIG.punishments.find(p => mr < p.threshold);
            if (p) html += `<tr><td>${escapeHtml(u.name)}</td><td>${mr}%</td><td>${p.description}</td><td><span class="badge bg-danger">نشط</span></td></tr>`;
        });
    }
    $('#punishmentsTableBody').html(html || '<tr><td colspan="4" class="text-center">لا توجد عقوبات</td></tr>');
    $('#punishmentsModal').modal('show');
}

// Chart
function initializeChart() {
    const users = Object.entries(localUsers).map(([id, u]) => ({ id, ...u }));
    const ctx = document.getElementById('progressChart').getContext('2d');
    progressChart = new Chart(ctx, {
        type: 'bar',
        data: { labels: users.map(u => u.name), datasets: [{ label: 'نسبة الإنجاز %', data: Array(users.length).fill(0), backgroundColor: ['rgba(255,107,107,0.8)','rgba(78,205,196,0.8)','rgba(69,183,209,0.8)','rgba(150,206,180,0.8)'], borderWidth: 2 }] },
        options: { responsive: true, plugins: { title: { display: true, text: 'إحصائيات الإنجاز الشهري' }, legend: { display: false } }, scales: { y: { beginAtZero: true, max: 100, ticks: { callback: v => v + '%' } } } }
    });
    updateChart();
}

function updateChart() {
    if (!progressChart) return;
    const users = Object.entries(localUsers).map(([id, u]) => ({ id, ...u }));
    progressChart.data.labels = users.map(u => u.name);
    progressChart.data.datasets[0].data = users.map(u => calcCompletionRate(u.id, currentMonth, currentYear));
    progressChart.update();
}

// ==================== P2P BROADCAST ====================
// Broadcast current data to all connected peers when data changes
function broadcastCurrentData() {
    if (typeof P2P === 'undefined' || !P2P.actions.family) return;
    P2P.broadcast && P2P.broadcast({
        type: 'family-sync',
        familyCode: familyCode,
        familyName: sessionStorage.getItem('familyName') || '',
        members: localUsers,
        tasks: localTasks,
        completions: localCompletions
    });
}

// ==================== P2P SHARE & DEVICES ====================

// Pending join requests (queued silently, rendered in share section)
let pendingJoinRequests = [];  // { peerId, deviceName, timestamp }
let joinRequestRateLimit = {}; // peerId → { count, firstAttempt }

// Initialize P2P on page load
$(document).ready(function() {
    if (typeof P2P !== 'undefined') {
        P2P.init({
            familyCode: familyCode,
            onMessage: function(peerId, message) {
                console.log('[App] P2P message from', peerId, message);
                // Handle incoming peer name
                if (message.type === 'peer-name' && message.name) {
                    if (P2P.peerList[peerId]) {
                        P2P.peerList[peerId].name = message.name;
                        P2P._savePeerList();
                        loadConnectedDevices();
                    }
                }
                // Handle incoming data sync
                if (message.type === 'family-sync') {
                    let changed = false;
                    // Sync members
                    if (message.members) {
                        Object.entries(message.members).forEach(([id, member]) => {
                            if (!localUsers[id] || member.createdAt > (localUsers[id].createdAt || 0)) {
                                localUsers[id] = member;
                                changed = true;
                            }
                        });
                    }
                    // Sync tasks
                    if (message.tasks) {
                        Object.entries(message.tasks).forEach(([id, task]) => {
                            if (!localTasks[id] || task.createdAt > (localTasks[id].createdAt || 0)) {
                                localTasks[id] = task;
                                changed = true;
                            }
                        });
                    }
                    // Sync completions (latest timestamp wins)
                    if (message.completions) {
                        Object.entries(message.completions).forEach(([id, comp]) => {
                            if (!localCompletions[id] || comp.timestamp > (localCompletions[id].timestamp || 0)) {
                                localCompletions[id] = comp;
                                changed = true;
                            }
                        });
                    }
                    if (changed) {
                        saveToLocal();
                        loadTaskTable();
                        createTaskLegend();
                        updateStatistics();
                    }
                }
                // Handle connection approved (new device receives this)
                if (message.type === 'connection-approved') {
                    console.log('[App] Connection approved, receiving data...');
                    Swal.close();
                    Swal.fire({
                        toast: true,
                        position: 'top-end',
                        icon: 'success',
                        title: 'تمت الموافقة! جاري تحميل البيانات...',
                        showConfirmButton: false,
                        timer: 3000
                    });
                }
                // Handle connection rejected (new device receives this)
                if (message.type === 'connection-rejected') {
                    console.log('[App] Connection rejected by admin');
                    Swal.close();
                    Swal.fire({
                        icon: 'error',
                        title: 'تم رفض الاتصال',
                        text: 'رفض مسؤول العائلة طلب الاتصال. تواصل معه للحصول على موافقة.',
                        confirmButtonText: 'حسناً'
                    });
                }
            },
            onPeerJoin: function(peerId) {
                console.log('[App] Peer joined:', peerId);
                updateSyncIndicator();
                loadConnectedDevices();
                // NOTE: Do NOT auto-send family data here.
                // The new device must send a join-request first, and admin must approve.
            },
            onPeerLeave: function(peerId) {
                console.log('[App] Peer left:', peerId);
                updateSyncIndicator();
                loadConnectedDevices();
            },
            onJoinRequest: function(peerId, requestData) {
                console.log('[App] Join request from:', peerId, requestData);
                handleJoinRequest(peerId, requestData);
            },
            onApprovedData: function(peerId, data) {
                // When admin sends data after approval, the requesting device receives this
            }
        });
    }
});

// Handle join request from a new device (admin side)
// Rate limited: max 5 requests per peer per 5 minutes
// Requests are queued silently — only shown in the share section
function handleJoinRequest(peerId, requestData) {
    const deviceName = requestData.deviceName || 'Unknown Device';
    const now = Date.now();

    // Rate limiting: max 5 requests per peer per 5 minutes
    if (!joinRequestRateLimit[peerId]) {
        joinRequestRateLimit[peerId] = { count: 0, firstAttempt: now };
    }
    const rateInfo = joinRequestRateLimit[peerId];

    // Reset window if 5 minutes have passed
    if (now - rateInfo.firstAttempt > 5 * 60 * 1000) {
        joinRequestRateLimit[peerId] = { count: 1, firstAttempt: now };
    } else {
        rateInfo.count++;
    }

    // Auto-reject if rate limit exceeded
    if (rateInfo.count > 5) {
        console.log('[App] Rate limit exceeded for peer:', peerId);
        P2P.rejectPeer(peerId);
        return;
    }

    // Check if already pending (avoid duplicates)
    const existing = pendingJoinRequests.findIndex(r => r.peerId === peerId);
    if (existing >= 0) {
        // Update existing request
        pendingJoinRequests[existing].deviceName = deviceName;
        pendingJoinRequests[existing].timestamp = now;
    } else {
        // Add new request
        pendingJoinRequests.push({ peerId, deviceName, timestamp: now });
    }

    // Update badge
    updateJoinRequestsBadge();

    // If share section is visible, render immediately
    renderJoinRequests();
}

// Update the badge on settings gear icon
function updateJoinRequestsBadge() {
    const badge = document.getElementById('joinRequestsBadge');
    if (badge) {
        if (pendingJoinRequests.length > 0) {
            badge.textContent = pendingJoinRequests.length;
            badge.style.display = 'flex';
        } else {
            badge.style.display = 'none';
        }
    }
}

// Render join requests in the share section
function renderJoinRequests() {
    const container = document.getElementById('joinRequestsList');
    if (!container) return;

    if (pendingJoinRequests.length === 0) {
        container.innerHTML = '<p class="text-muted"><small>لا توجد طلبات حالياً</small></p>';
        return;
    }

    let html = '';
    pendingJoinRequests.forEach((req) => {
        const timeAgo = getTimeAgo(req.timestamp);
        html += `<div class="join-request-card" id="request-${req.peerId}">
            <div class="d-flex justify-content-between align-items-center">
                <div>
                    <div class="request-info">
                        <i class="bi bi-phone"></i> ${escapeHtml(req.deviceName)}
                    </div>
                    <div class="request-time">${timeAgo}</div>
                </div>
                <div class="d-flex gap-2">
                    <button class="btn btn-sm btn-success" onclick="approveRequest('${req.peerId}')" title="قبول">
                        <i class="bi bi-check-lg"></i> قبول
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="rejectRequest('${req.peerId}')" title="رفض">
                        <i class="bi bi-x-lg"></i> رفض
                    </button>
                </div>
            </div>
        </div>`;
    });
    container.innerHTML = html;
}

// Approve a join request
function approveRequest(peerId) {
    const req = pendingJoinRequests.find(r => r.peerId === peerId);
    if (!req) return;

    P2P.approvePeer(peerId, req.deviceName);

    // Remove from queue
    pendingJoinRequests = pendingJoinRequests.filter(r => r.peerId !== peerId);
    updateJoinRequestsBadge();
    renderJoinRequests();
    loadConnectedDevices();

    Swal.fire({
        toast: true,
        position: 'top-end',
        icon: 'success',
        title: `تمت الموافقة على: ${escapeHtml(req.deviceName)}`,
        showConfirmButton: false,
        timer: 3000
    });
}

// Reject a join request
function rejectRequest(peerId) {
    const req = pendingJoinRequests.find(r => r.peerId === peerId);
    P2P.rejectPeer(peerId);

    // Remove from queue
    pendingJoinRequests = pendingJoinRequests.filter(r => r.peerId !== peerId);
    updateJoinRequestsBadge();
    renderJoinRequests();

    Swal.fire({
        toast: true,
        position: 'top-end',
        icon: 'info',
        title: 'تم رفض الاتصال',
        showConfirmButton: false,
        timer: 2000
    });
}

// Load share section (QR + link + pending requests)
function loadShareSection() {
    const qrEl = document.getElementById('shareQRCode');
    const linkEl = document.getElementById('shareLink');
    const statusEl = document.getElementById('shareRoomStatus');

    // Check P2P room status
    const isP2PReady = typeof P2P !== 'undefined' && P2P._joined && P2P.room;
    const roomId = typeof P2P !== 'undefined' ? P2P.getStoredRoomId(familyCode) : null;

    // Show room status
    if (statusEl) {
        if (isP2PReady) {
            const peerCount = P2P.connectedPeers.size;
            statusEl.innerHTML = `<div class="alert alert-success mb-3">
                <i class="bi bi-check-circle-fill"></i> <strong>الغرفة نشطة</strong> — جاهز لاستقبال الأجهزة الجديدة
                ${peerCount > 0 ? `<br><small><i class="bi bi-wifi"></i> ${peerCount} جهاز متصل حالياً</small>` : ''}
            </div>`;
        } else {
            statusEl.innerHTML = `<div class="alert alert-warning mb-3">
                <i class="bi bi-hourglass-split"></i> <strong>جاري الاتصال بالغرفة...</strong>
                <br><small>يرجى الانتظار حتى يتم تأسيس الاتصال</small>
            </div>`;
        }
    }

    if (!roomId) {
        if (qrEl) qrEl.innerHTML = '<p class="text-muted">لم يتم العثور على معرف الغرفة</p>';
        return;
    }

    const baseUrl = window.location.origin + window.location.pathname.replace(/\/app\/index\.html$/, '/index.html');
    const shareUrl = baseUrl + '?join=' + encodeURIComponent(familyCode) + '&room=' + encodeURIComponent(roomId);

    // Generate QR code
    if (typeof qrcode !== 'undefined') {
        const qr = qrcode(0, 'M');
        qr.addData(shareUrl);
        qr.make();
        if (qrEl) qrEl.innerHTML = qr.createSvgTag(4, 0);
    }

    if (linkEl) linkEl.value = shareUrl;

    // If P2P isn't ready yet, poll and update when it becomes ready
    if (!isP2PReady && typeof P2P !== 'undefined') {
        const checkReady = setInterval(() => {
            if (P2P._joined && P2P.room) {
                clearInterval(checkReady);
                loadShareSection(); // Reload with ready status
            }
        }, 1000);
        // Stop checking after 10 seconds
        setTimeout(() => clearInterval(checkReady), 10000);
    }

    // Render any pending join requests
    renderJoinRequests();
}

function copyShareLink() {
    const link = document.getElementById('shareLink');
    if (link) {
        navigator.clipboard.writeText(link.value);
        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'تم النسخ', showConfirmButton: false, timer: 1500 });
    }
}

function shareViaWhatsApp() {
    const link = document.getElementById('shareLink');
    if (link) {
        const text = encodeURIComponent('انضم لجدول المهام العائلي: ' + link.value);
        window.open('https://wa.me/?text=' + text, '_blank');
    }
}

function updateSyncIndicator() {
    const connected = typeof P2P !== 'undefined' ? Object.keys(P2P.getConnectedPeers()).length : 0;
    const dot = document.querySelector('.sync-dot');
    if (dot) {
        dot.style.background = connected > 0 ? '#34d399' : '#94a3b8';
        dot.title = connected > 0 ? `${connected} جهاز متصل` : 'غير متصل';
    }
}

// showShareDevice removed — share is now inside settings overlay (loadShareSection)

// handleIncomingConnection removed — dead code (old WebRTC offer/answer flow)

function loadConnectedDevices() {
    if (typeof P2P === 'undefined') return;
    const peers = P2P.getAllPeers();
    const connected = P2P.getConnectedPeers();
    const peerEntries = Object.entries(peers);
    const approvedTokens = P2P.getApprovedTokens();
    const approvedEntries = Object.entries(approvedTokens);

    let html = '';

    // Section: Approved Devices (from approval tokens)
    if (approvedEntries.length > 0) {
        html += '<h6 class="mb-2 mt-1"><i class="bi bi-shield-check text-success"></i> الأجهزة الموثقة</h6>';
        approvedEntries.forEach(([hash, info]) => {
            const timeAgo = info.lastSeen ? getTimeAgo(info.lastSeen) : '';
            const approvedDate = info.approvedAt ? new Date(info.approvedAt).toLocaleDateString('ar-SA') : '';
            html += `<div class="d-flex justify-content-between align-items-center p-2 mb-2" style="background:#f0fdf4;border-radius:10px;border:1px solid #bbf7d0;">
                <div><strong>${escapeHtml(info.deviceName || 'جهاز غير معروف')}</strong><br><small style="color:#94a3b8;">موثق منذ ${approvedDate} ${timeAgo ? '· آخر اتصال: ' + timeAgo : ''}</small></div>
                <div class="d-flex align-items-center gap-2">
                    <span style="width:8px;height:8px;border-radius:50%;background:var(--success);" title="موثق"></span>
                    <button class="btn btn-sm btn-outline-danger" onclick="revokeApprovedDevice('${hash}', '${escapeHtml(info.deviceName || '')}')" title="إزالة التوثيق"><i class="bi bi-x-lg"></i></button>
                </div>
            </div>`;
        });
    }

    // Section: Connected Peers
    if (peerEntries.length > 0) {
        html += '<h6 class="mb-2 mt-3"><i class="bi bi-wifi text-primary"></i> الأجهزة المتصلة</h6>';
        peerEntries.forEach(([id, peer]) => {
            const isConnected = !!connected[id];
            const statusColor = isConnected ? 'var(--success)' : '#94a3b8';
            const statusText = isConnected ? 'متصل' : 'غير متصل';
            const timeAgo = peer.lastSeen ? getTimeAgo(peer.lastSeen) : '';
            html += `<div class="d-flex justify-content-between align-items-center p-2 mb-2" style="background:#f8fafc;border-radius:10px;">
                <div><strong>${escapeHtml(peer.name || id)}</strong><br><small style="color:#94a3b8;">${statusText} ${timeAgo ? '· ' + timeAgo : ''}</small></div>
                <div class="d-flex align-items-center gap-2">
                    <span style="width:8px;height:8px;border-radius:50%;background:${statusColor};"></span>
                    <button class="btn btn-sm btn-outline-danger" onclick="disconnectDevice('${id}')" title="قطع الاتصال"><i class="bi bi-x-lg"></i></button>
                </div>
            </div>`;
        });
    }

    if (peerEntries.length === 0 && approvedEntries.length === 0) {
        html = '<p class="text-muted"><i class="bi bi-info-circle"></i> لا توجد أجهزة متصلة أو موثقة. اضغط "مشاركة الجهاز" لإضافة أجهزة.</p>';
    }

    $('#connectedDevicesList').html(html);
}

function disconnectDevice(peerId) {
    if (typeof P2P !== 'undefined') {
        P2P.removePeer(peerId);
        loadConnectedDevices();
        updateSyncIndicator();
        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'تم قطع الاتصال', showConfirmButton: false, timer: 1500 });
    }
}

async function revokeApprovedDevice(tokenHash, deviceName) {
    const result = await Swal.fire({
        title: 'إزالة التوثيق',
        html: `هل تريد إزالة توثيق الجهاز: <strong>${escapeHtml(deviceName)}</strong>؟<br><small class="text-muted">سيحتاج الجهاز إلى موافقة جديدة للاتصال.</small>`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'نعم، أزل التوثيق',
        cancelButtonText: 'إلغاء',
        confirmButtonColor: '#ef4444'
    });

    if (result.isConfirmed) {
        await P2P.revokeApprovedToken(tokenHash);
        loadConnectedDevices();
        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'تم إزالة توثيق الجهاز', showConfirmButton: false, timer: 1500 });
    }
}

function getTimeAgo(timestamp) {
    const diff = Date.now() - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'الآن';
    if (mins < 60) return `منذ ${mins} دقيقة`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `منذ ${hours} ساعة`;
    return `منذ ${Math.floor(hours / 24)} يوم`;
}

// Settings overlay
function openSettings() {
    // Always require PIN to enter settings (admin page)
    promptPinForSettings(function() {
        $('#settingsOverlay').addClass('active');
        $('body').addClass('settings-open');
        // Load settings data
        if (typeof loadSettingsData === 'function') loadSettingsData();
    });
}

function closeSettings() {
    $('#settingsOverlay').removeClass('active');
    $('body').removeClass('settings-open');
}

// PIN prompt for settings entry (ALWAYS asks, no grace period)
async function promptPinForSettings(callback) {
    // If no users have PINs, allow entry
    const usersWithPins = Object.values(localUsers).filter(u => u.pinHash);
    if (usersWithPins.length === 0) { callback(); return; }

    // Build user list for selection
    const allUsers = Object.entries(localUsers).map(([id, u]) => ({ id, ...u }));
    const inputOptions = {};
    allUsers.forEach(u => { inputOptions[u.id] = u.name; });

    const { value: formValues } = await Swal.fire({
        title: '<i class="bi bi-shield-lock"></i> الدخول للإعدادات',
        html: '<p class="text-muted mb-3">أدخل الرمز الشخصي للوصول</p>',
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
        // User has no PIN, allow entry
        lastPinVerification = Date.now();
        callback();
        return;
    }

    const { value: pin } = await Swal.fire({
        title: `<i class="bi bi-person-fill"></i> ${escapeHtml(selectedUser.name)}`,
        html: '<p class="text-muted mb-3">أدخل الرمز الشخصي</p>',
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
        callback();
    }
}

// Utilities
function getWeekNumber(date) { const f = new Date(date.getFullYear(), date.getMonth(), 1); return Math.ceil((date.getDate() + f.getDay()) / 7); }
function getWeeksInMonth(y, m) { return getWeekNumber(new Date(y, m + 1, 0)); }
function getDaysInWeekOfMonth(w, m, y) { const f = new Date(y, m, 1), o = f.getDay(), d = new Date(y, m + 1, 0).getDate(); const s = Math.max(1, (w-1)*7-o+1), e = Math.min(d, w*7-o); return s > e ? 0 : e - s + 1; }
function scrollToCurrentDay() { setTimeout(() => { const t = new Date(); if (currentMonth === t.getMonth() && currentYear === t.getFullYear()) { const el = $('tr.current-day'); if (el.length) { const w = $('.table-wrapper'); w.animate({ scrollTop: el.offset().top - w.offset().top - 50 }, 500); } } }, 500); }
function showStatistics() { updateRewardsAndPunishments(); updateChart(); $('#statisticsModal').modal('show'); }
function updateRewardsAndPunishments() { /* updates are done in showRewards/showPunishments */ }

function logout() {
    sessionStorage.clear();
    localStorage.removeItem('taskSchedule_lastSession');
    Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'تم تسجيل الخروج', showConfirmButton: false, timer: 1500 });
    setTimeout(() => { window.location.href = '../index.html'; }, 1500);
}

// Keyboard shortcuts
$(document).keydown(function(e) { if (e.ctrlKey && e.key === 'r') { e.preventDefault(); location.reload(); } });
$(document).ready(function() { $('.modal').on('click', function(e) { if (e.target === this) $(this).modal('hide'); }); $(document).on('keydown', function(e) { if (e.key === 'Escape') { if ($('#settingsOverlay').hasClass('active')) { closeSettings(); } else { $('.modal.show').modal('hide'); } } }); });