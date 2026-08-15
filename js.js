const SUPABASE_URL = 'https://eucaziymnjjpkbwbxwfj.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_ulLjvVJ81xRdSS_Wz9Qh4Q_nMSAlSfO';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
let supabaseSession = null;
let syncTimer = null;
let syncInProgress = false;
let realtimeChannel = null;
const pendingSyncIds = new Set();

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function ensureUuidIds() {
  let changed = false;
  state.leads.forEach(lead => {
    if (!isUuid(lead.id)) {
      lead.id = crypto.randomUUID();
      changed = true;
    }
  });
  if (changed) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function leadToSupabaseRow(lead) {
  return {
    id: lead.id,
    name: lead.name || '',
    company: lead.company || '',
    phone: lead.phone || '',
    site: lead.site || '',
    lead_type: getLeadType(lead) || '',
    tags: Array.isArray(lead.tags) ? lead.tags : [],
    spanish_possible: Boolean(lead.spanishPossible),
    age: lead.age || '',
    issue: lead.issue || '',
    concerns: lead.concerns || '',
    notes: lead.notes || '',
    answer_status: lead.answerStatus || '',
    mood: lead.mood || '',
    outcome: lead.outcome || '',
    callback_date: lead.callbackDate || null,
    callback_time: lead.callbackTime || null,
    preferred_contact: lead.preferredContact || '',
    preferred_date: lead.preferredDate || null,
    preferred_time: lead.preferredTime || null,
    preferred_days: Array.isArray(lead.days) ? lead.days : [],
    time_preference: lead.timePreference || '',
    specific_time: lead.specificTime || null,
    tag: lead.tag || '',
    last_called: lead.lastCalled || null,
    updated_at: new Date().toISOString()
  };
}

function supabaseRowToLead(row, status = 'new') {
  return {
    id: row.id,
    name: row.name || '',
    company: row.company || '',
    phone: row.phone || '',
    site: row.site || '',
    age: row.age || '',
    issue: row.issue || '',
    leadType: row.lead_type || '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    spanishPossible: Boolean(row.spanish_possible),
    status,
    lastCalled: row.last_called || '',
    tag: row.tag || '',
    answerStatus: row.answer_status || '',
    mood: row.mood || '',
    outcome: row.outcome || '',
    callbackDate: row.callback_date || '',
    callbackTime: row.callback_time || '',
    preferredContact: row.preferred_contact || '',
    preferredDate: row.preferred_date || '',
    preferredTime: row.preferred_time || '',
    days: Array.isArray(row.preferred_days) ? row.preferred_days : [],
    timePreference: row.time_preference || '',
    specificTime: row.specific_time || '',
    concerns: row.concerns || '',
    notes: row.notes || ''
  };
}

function tableForLead(lead) {
  return lead?.status === 'followup' ? 'follow_ups' : 'new_leads';
}

function otherTableForLead(lead) {
  return lead?.status === 'followup' ? 'new_leads' : 'follow_ups';
}

function showSyncStatus(text) {
  let pill = document.getElementById('syncPill');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'syncPill';
    pill.className = 'sync-pill';
    document.body.appendChild(pill);
  }
  pill.textContent = text;
  pill.classList.add('show');
  clearTimeout(pill._timer);
  pill._timer = setTimeout(() => pill.classList.remove('show'), 1400);
}

async function upsertLeadsByTable(leads) {
  const newRows = leads.filter(lead => lead.status !== 'followup').map(leadToSupabaseRow);
  const followRows = leads.filter(lead => lead.status === 'followup').map(leadToSupabaseRow);

  if (newRows.length) {
    const { error } = await supabaseClient.from('new_leads').upsert(newRows, { onConflict: 'id' });
    if (error) throw error;
    const ids = newRows.map(row => row.id);
    const { error: cleanupError } = await supabaseClient.from('follow_ups').delete().in('id', ids);
    if (cleanupError) throw cleanupError;
  }

  if (followRows.length) {
    const { error } = await supabaseClient.from('follow_ups').upsert(followRows, { onConflict: 'id' });
    if (error) throw error;
    const ids = followRows.map(row => row.id);
    const { error: cleanupError } = await supabaseClient.from('new_leads').delete().in('id', ids);
    if (cleanupError) throw cleanupError;
  }
}

async function syncAllLeadsToSupabase() {
  if (!supabaseSession || syncInProgress) return;
  syncInProgress = true;
  try {
    ensureUuidIds();
    if (state.leads.length) await upsertLeadsByTable(state.leads);
    showSyncStatus('Synced');
  } catch (error) {
    console.error('Supabase sync failed:', error);
    showSyncStatus('Sync failed');
  } finally {
    syncInProgress = false;
  }
}

async function syncPendingLeadsToSupabase() {
  if (!supabaseSession || syncInProgress || !pendingSyncIds.size) return;
  syncInProgress = true;
  const ids = [...pendingSyncIds];
  try {
    ensureUuidIds();
    const leads = state.leads.filter(lead => ids.includes(lead.id));
    if (leads.length) await upsertLeadsByTable(leads);
    ids.forEach(id => pendingSyncIds.delete(id));
    showSyncStatus('Synced');
  } catch (error) {
    console.error('Supabase sync failed:', error);
    showSyncStatus('Sync failed');
  } finally {
    syncInProgress = false;
    if (pendingSyncIds.size) queueLeadSync();
  }
}

function queueLeadSync(...ids) {
  if (!supabaseSession) return;
  ids.filter(Boolean).forEach(id => pendingSyncIds.add(id));
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncPendingLeadsToSupabase, 300);
}

function queueAllLeadSync() {
  state.leads.forEach(lead => pendingSyncIds.add(lead.id));
  queueLeadSync();
}

async function syncLeadNow(lead) {
  if (!supabaseSession || !lead) return;
  pendingSyncIds.delete(lead.id);
  const table = tableForLead(lead);
  const otherTable = otherTableForLead(lead);
  const { error } = await supabaseClient.from(table).upsert(leadToSupabaseRow(lead), { onConflict: 'id' });
  if (error) throw error;
  const { error: cleanupError } = await supabaseClient.from(otherTable).delete().eq('id', lead.id);
  if (cleanupError) throw cleanupError;
}

function applyRealtimeLeadChange(payload, status) {
  if (!payload) return;
  if (payload.eventType === 'DELETE') {
    const deletedId = payload.old?.id;
    const index = state.leads.findIndex(lead => lead.id === deletedId);
    if (index >= 0 && state.leads[index].status === status) state.leads.splice(index, 1);
  } else {
    const incoming = supabaseRowToLead(payload.new || {}, status);
    if (!incoming.id) return;
    const index = state.leads.findIndex(lead => lead.id === incoming.id);
    if (index >= 0) state.leads[index] = incoming;
    else state.leads.push(incoming);
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  renderLists();
  if (currentLeadId && state.leads.some(lead => lead.id === currentLeadId)) renderCurrentLead();
  else if (currentLeadId) {
    currentLeadId = null;
    showScreen('leads');
  }
}

function subscribeToLeadChanges() {
  if (!supabaseSession) return;
  if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
  realtimeChannel = supabaseClient
    .channel('steady-hands-leads-live-v2')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'new_leads' }, payload => applyRealtimeLeadChange(payload, 'new'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'follow_ups' }, payload => applyRealtimeLeadChange(payload, 'followup'))
    .subscribe();
}

function unsubscribeFromLeadChanges() {
  if (!realtimeChannel) return;
  supabaseClient.removeChannel(realtimeChannel);
  realtimeChannel = null;
}

async function hydrateFromSupabase() {
  if (!supabaseSession) return;
  ensureUuidIds();

  const [{ data: newData, error: newError }, { data: followData, error: followError }] = await Promise.all([
    supabaseClient.from('new_leads').select('*').order('created_at', { ascending: true }),
    supabaseClient.from('follow_ups').select('*').order('created_at', { ascending: true })
  ]);

  if (newError) throw newError;
  if (followError) throw followError;

  const remoteLeads = [
    ...(newData || []).map(row => supabaseRowToLead(row, 'new')),
    ...(followData || []).map(row => supabaseRowToLead(row, 'followup'))
  ];

  // The database is the source of truth once the two-table setup is in use.
  // Only migrate browser-local leads if both database tables are completely empty.
  if (!remoteLeads.length && state.leads.length) {
    await upsertLeadsByTable(state.leads);
    return hydrateFromSupabase();
  }

  state.leads = remoteLeads;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  renderLists();
}

function setAuthenticatedUi(isAuthenticated) {
  document.getElementById('authGate').hidden = isAuthenticated;
  document.getElementById('appShell').hidden = !isAuthenticated;
}

async function initializeSupabaseAuth() {
  const { data } = await supabaseClient.auth.getSession();
  supabaseSession = data.session || null;
  setAuthenticatedUi(Boolean(supabaseSession));
  if (supabaseSession) {
    try { await hydrateFromSupabase(); subscribeToLeadChanges(); } catch (error) { console.error(error); showSyncStatus('Sync failed'); }
  }
}

const STORAGE_KEY = 'steadyHandsLeadApp_v5_two_tables';

const seedLeads = [];

let state = loadState();
let currentLeadId = null;
let selectedDoneTag = '';
let selectedSpanishPossible = false;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && Array.isArray(saved.leads)) {
      // Remove the old addedAt field from previously saved leads.
      saved.leads = saved.leads.map(lead => {
        const { addedAt, AddedAt, addedat, ...cleanLead } = lead || {};
        return cleanLead;
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      return saved;
    }
  } catch (_) {}
  return { leads: structuredClone(seedLeads) };
}

function saveState(...leadIds) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  const ids = leadIds.filter(Boolean);
  if (ids.length) queueLeadSync(...ids);
  else if (currentLeadId) queueLeadSync(currentLeadId);
  else queueAllLeadSync();
}


function formatPhoneNumber(value) {
  const digits = String(value ?? '').replace(/\D/g, '').slice(0, 10);
  if (!digits) return '';
  if (digits.length < 4) return `(${digits}`;
  if (digits.length < 7) return `(${digits.slice(0,3)})${digits.slice(3)}`;
  return `(${digits.slice(0,3)})${digits.slice(3,6)}-${digits.slice(6)}`;
}

function currentLead() {
  return state.leads.find(lead => lead.id === currentLeadId);
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
  }).format(date);
}

function showScreen(name) {
  $('#leadsScreen').classList.toggle('active', name === 'leads');
  $('#detailScreen').classList.toggle('active', name === 'detail');
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function normalizeLeadType(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const key = text.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/outdated|old (site|website)|dated (site|website)/.test(key)) return 'Outdated Site';
  if (/no (site|website)|without (a )?(site|website)|needs? (a )?website/.test(key)) return 'No Site';
  if (/broken|not working|404|dead link|error/.test(key)) return 'Broken Site';
  if (/spanish/.test(key)) return 'Spanish?';
  return text;
}

function getLeadType(lead) {
  const tagType = Array.isArray(lead.tags)
    ? lead.tags.map(normalizeLeadType).find(value => value && value !== 'Spanish?')
    : '';
  return normalizeLeadType(lead.leadType || lead.type || lead.reason || tagType);
}

function hasPossibleSpanishTag(lead) {
  return Boolean(lead.spanishPossible) || (Array.isArray(lead.tags) && lead.tags.some(tag => normalizeLeadType(tag) === 'Spanish?'));
}

function quickInfoTags(lead) {
  const items = [];
  const seen = new Set();
  const add = (label, kind, raw = '') => {
    const clean = String(label || '').trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ label: clean, kind, raw });
  };

  const leadType = getLeadType(lead);
  if (leadType && leadType !== 'Spanish?') add(leadType, 'leadType');
  if (hasPossibleSpanishTag(lead) || leadType === 'Spanish?') add('Spanish?', 'spanish');

  if (Array.isArray(lead.tags)) {
    lead.tags.forEach(raw => {
      const normalized = normalizeLeadType(raw);
      if (!normalized || normalized === 'Spanish?' || normalized === leadType) return;
      add(raw, 'raw', raw);
    });
  }

  if (lead.tag) add(lead.tag, 'followupTag');
  return items;
}

function renderQuickInfoTags() {
  const lead = currentLead();
  const list = $('#quickTagsList');
  if (!lead || !list) return;
  const tags = quickInfoTags(lead);
  if (!tags.length) {
    list.innerHTML = '<span class="quick-tags-empty">No tags</span>';
    return;
  }
  list.innerHTML = tags.map(tag => `
    <button class="quick-tag-chip ${tag.kind === 'spanish' ? 'spanish' : ''}" type="button"
      data-remove-tag-kind="${escapeHTML(tag.kind)}" data-remove-tag-raw="${escapeHTML(tag.raw)}"
      aria-label="Remove ${escapeHTML(tag.label)} tag">
      <span>${escapeHTML(tag.label)}</span><i class="bi bi-x-lg" aria-hidden="true"></i>
    </button>`).join('');
}

async function removeQuickInfoTag(kind, raw) {
  const lead = currentLead();
  if (!lead) return;

  if (kind === 'leadType') {
    const oldType = getLeadType(lead);
    lead.leadType = '';
    lead.type = '';
    lead.reason = '';
    if (Array.isArray(lead.tags)) {
      lead.tags = lead.tags.filter(tag => normalizeLeadType(tag) !== oldType);
    }
  } else if (kind === 'spanish') {
    lead.spanishPossible = false;
    if (Array.isArray(lead.tags)) {
      lead.tags = lead.tags.filter(tag => normalizeLeadType(tag) !== 'Spanish?');
    }
  } else if (kind === 'followupTag') {
    lead.tag = '';
  } else if (kind === 'raw') {
    lead.tags = (lead.tags || []).filter(tag => String(tag) !== String(raw));
  }

  saveState(lead.id);
  renderQuickInfoTags();
  renderLists();
  try {
    await syncLeadNow(lead);
    showSyncStatus('Tag removed');
  } catch (error) {
    console.error('Could not remove tag in Supabase:', error);
    showSyncStatus('Sync failed');
  }
}

function leadCard(lead) {
  const isNew = lead.status === 'new';
  const meta = isNew ? '' : `Last called: ${formatDateTime(lead.lastCalled)}`;
  const leadType = getLeadType(lead);
  const badges = [
    leadType && leadType !== 'Spanish?' ? `<span class="lead-type-badge">${escapeHTML(leadType)}</span>` : '',
    hasPossibleSpanishTag(lead) || leadType === 'Spanish?' ? '<span class="lead-type-badge spanish-badge">Spanish?</span>' : '',
    !isNew && lead.tag ? `<span class="tag-badge">${escapeHTML(lead.tag)}</span>` : ''
  ].filter(Boolean).join('');
  const initial = (lead.name || '?').trim().charAt(0).toUpperCase();

  return `
    <button class="lead-item" type="button" data-open-lead="${lead.id}">
      <span class="lead-avatar">${escapeHTML(initial)}</span>
      <span class="lead-copy">
        <span class="lead-name-line"><strong>${escapeHTML(lead.company || 'No company')}</strong>${badges}</span>
        <span class="lead-company">${escapeHTML(lead.name || 'No contact name')}</span>
        ${meta ? `<span class="lead-meta">${escapeHTML(meta)}</span>` : ''}
      </span>
      <i class="bi bi-chevron-right"></i>
    </button>`;
}

function renderLists() {
  const query = ($('#leadSearch').value || '').trim().toLowerCase();
  const matches = lead => !query || [lead.name, lead.company, lead.phone, lead.tag, getLeadType(lead), hasPossibleSpanishTag(lead) ? 'Spanish?' : ''].some(v => String(v || '').toLowerCase().includes(query));
  const fresh = state.leads.filter(l => l.status === 'new' && matches(l)).slice().reverse();
  const follow = state.leads.filter(l => l.status === 'followup' && matches(l)).sort((a,b) => new Date(b.lastCalled || 0) - new Date(a.lastCalled || 0));

  $('#newLeadList').innerHTML = fresh.length ? fresh.map(leadCard).join('') : '<div class="empty-state">No new leads here.</div>';
  $('#followLeadList').innerHTML = follow.length ? follow.map(leadCard).join('') : '<div class="empty-state">No follow-ups yet.</div>';

  const newCount = state.leads.filter(l => l.status === 'new').length;
  const followCount = state.leads.filter(l => l.status === 'followup').length;
  const soldCount = state.leads.filter(l => l.tag === 'Sold').length;
  $('#newCount').textContent = newCount;
  $('#followCount').textContent = followCount;
  $('#soldCount').textContent = soldCount;
  $('#newCountChip').textContent = newCount;
  $('#followCountChip').textContent = followCount;
}

function openLead(id) {
  currentLeadId = id;
  renderCurrentLead();
  showScreen('detail');
}

function renderCurrentLead() {
  const lead = currentLead();
  if (!lead) return;

  $('#leadPhone').textContent = lead.phone ? formatPhoneNumber(lead.phone) : 'No phone';
  $('#topCallButton').href = `tel:${String(lead.phone || '').replace(/[^\d+]/g, '')}`;
  $('#leadName').textContent = lead.name || '—';
  $('#leadCompany').textContent = lead.company || '—';
  $('#leadSite').textContent = lead.site || '—';
  $('#leadSite').href = lead.site || '#';
  $('#leadAge').textContent = lead.age || '—';
  $('#leadIssue').textContent = lead.issue || '—';

  $('#outcomeField').value = lead.outcome || '';
  $('#preferredContact').value = lead.preferredContact || '';
  renderScheduleEditor('callback', lead.callbackDate || '', lead.callbackTime || '');
  renderScheduleEditor('preferred', lead.preferredDate || '', lead.preferredTime || '');
  const specificControl = $('#specificTimeControl');
  if (specificControl) specificControl.hidden = lead.timePreference !== 'Specific Time';
  loadSpecificTime(lead.specificTime || '');
  $('#concernsField').value = lead.concerns || '';
  $('#notesField').value = lead.notes || '';
  renderQuickInfoTags();

  $$('[data-field]').forEach(button => {
    button.classList.toggle('selected', lead[button.dataset.field] === button.dataset.value);
  });
  $$('[data-multi="days"]').forEach(button => {
    button.classList.toggle('selected', (lead.days || []).includes(button.dataset.value));
  });

  // New lead requirement: no status or mood starts highlighted until the user picks one.
  // Follow-up leads retain selections because they were previously saved.
}

function setTab(panelId) {
  $$('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === panelId));
  $$('.panel').forEach(panel => panel.classList.toggle('active', panel.id === panelId));
}

function autosaveField(element) {
  const lead = currentLead();
  if (!lead) return;
  lead[element.dataset.save] = element.value;
  saveState();
}


const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function localDateParts(date = new Date()) {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate()
  };
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function scheduleIds(prefix) {
  return {
    editor: $(`#${prefix}Editor`),
    add: $(`#add${prefix[0].toUpperCase() + prefix.slice(1)}Button`),
    month: $(`#${prefix}Month`),
    day: $(`#${prefix}Day`),
    year: $(`#${prefix}Year`),
    hour: $(`#${prefix}Hour`),
    minute: $(`#${prefix}Minute`),
    period: $(`#${prefix}Period`),
    timeButton: $(`#${prefix}TimeButton`),
    timeDisplay: $(`#${prefix}TimeDisplay`),
    timePicker: $(`#${prefix}TimePicker`)
  };
}

function ensureYearOption(select, year) {
  if (![...select.options].some(option => Number(option.value) === Number(year))) {
    const option = new Option(String(year), String(year));
    const options = [...select.options, option].sort((a,b) => Number(a.value) - Number(b.value));
    select.replaceChildren(...options);
  }
}

function populateDayOptions(select, year, month, selectedDay) {
  const max = new Date(Number(year), Number(month), 0).getDate();
  const safeDay = Math.min(Math.max(Number(selectedDay) || 1, 1), max);
  select.innerHTML = '';
  for (let day = 1; day <= max; day++) select.add(new Option(String(day), String(day)));
  select.value = String(safeDay);
  return safeDay;
}

function initializeScheduleDropdown(prefix) {
  const ids = scheduleIds(prefix);
  const now = localDateParts();

  ids.month.innerHTML = MONTH_NAMES.map((name, index) => `<option value="${index + 1}">${name}</option>`).join('');
  ids.year.innerHTML = '';
  for (let year = now.year - 1; year <= now.year + 10; year++) ids.year.add(new Option(String(year), String(year)));

  // Time values are deliberately blank until the user picks each part.
  for (let hour = 1; hour <= 12; hour++) ids.hour.add(new Option(String(hour), String(hour)));
  ['00','15','30','45'].forEach(minute => ids.minute.add(new Option(minute, minute)));

  ids.month.value = String(now.month);
  ids.year.value = String(now.year);
  populateDayOptions(ids.day, now.year, now.month, now.day);
  ids.month.dataset.previousMonth = String(now.month);
}

function parseSavedDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function updateTimeDisplay(prefix) {
  const ids = scheduleIds(prefix);
  if (!ids.timeDisplay) return;
  const hour = ids.hour.value;
  const minute = ids.minute.value;
  const period = ids.period.value;
  ids.timeDisplay.textContent = (hour && minute !== '' && period)
    ? `${pad2(hour)}:${minute} ${period}`
    : '00:00 AM';
}

function closeTimePicker(prefix) {
  const ids = scheduleIds(prefix);
  if (!ids.timePicker || !ids.timeButton) return;
  ids.timePicker.hidden = true;
  ids.timeButton.setAttribute('aria-expanded', 'false');
}

function setTimeDropdowns(prefix, timeValue) {
  const ids = scheduleIds(prefix);
  ids.hour.value = '';
  ids.minute.value = '';
  ids.period.value = '';
  const match = /^(\d{1,2}):(\d{2})/.exec(timeValue || '');
  if (!match) { updateTimeDisplay(prefix); return; }

  const hour24 = Math.min(23, Math.max(0, Number(match[1])));
  const rawMinute = Number(match[2]);
  const minute = ['00','15','30','45'].reduce((best, option) =>
    Math.abs(Number(option) - rawMinute) < Math.abs(Number(best) - rawMinute) ? option : best, '00');
  const period = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 || 12;
  ids.hour.value = String(hour12);
  ids.minute.value = minute;
  ids.period.value = period;
  updateTimeDisplay(prefix);
}

function renderScheduleEditor(prefix, dateValue, timeValue) {
  const ids = scheduleIds(prefix);
  const hasData = Boolean(dateValue || timeValue);
  ids.editor.hidden = !hasData;
  ids.add.hidden = hasData;
  if (!hasData) return;

  const now = localDateParts();
  const date = parseSavedDate(dateValue) || now;
  ensureYearOption(ids.year, date.year);
  ids.month.value = String(date.month);
  ids.year.value = String(date.year);
  populateDayOptions(ids.day, date.year, date.month, date.day);
  ids.month.dataset.previousMonth = String(date.month);
  setTimeDropdowns(prefix, timeValue);
}

function scheduleFieldNames(prefix) {
  return prefix === 'callback'
    ? { date: 'callbackDate', time: 'callbackTime' }
    : { date: 'preferredDate', time: 'preferredTime' };
}

function saveSchedule(prefix) {
  const lead = currentLead();
  if (!lead) return;
  const ids = scheduleIds(prefix);
  const fields = scheduleFieldNames(prefix);
  const year = Number(ids.year.value);
  const month = Number(ids.month.value);
  const day = populateDayOptions(ids.day, year, month, Number(ids.day.value));
  lead[fields.date] = `${year}-${pad2(month)}-${pad2(day)}`;

  const hour = Number(ids.hour.value);
  const minute = ids.minute.value;
  const period = ids.period.value;
  if (hour && minute !== '' && period) {
    let hour24 = hour % 12;
    if (period === 'PM') hour24 += 12;
    lead[fields.time] = `${pad2(hour24)}:${minute}`;
  } else {
    lead[fields.time] = '';
  }
  updateTimeDisplay(prefix);
  saveState();
}

function addSchedule(prefix) {
  const lead = currentLead();
  if (!lead) return;
  const fields = scheduleFieldNames(prefix);
  const now = localDateParts();
  lead[fields.date] = `${now.year}-${pad2(now.month)}-${pad2(now.day)}`;
  lead[fields.time] = '';
  saveState();
  renderScheduleEditor(prefix, lead[fields.date], lead[fields.time]);
}

function clearSchedule(prefix) {
  const lead = currentLead();
  if (!lead) return;
  const fields = scheduleFieldNames(prefix);
  lead[fields.date] = '';
  lead[fields.time] = '';
  saveState();
  renderScheduleEditor(prefix, '', '');
}

function bindScheduleEditor(prefix) {
  const ids = scheduleIds(prefix);
  const cap = prefix[0].toUpperCase() + prefix.slice(1);
  $(`#add${cap}Button`).addEventListener('click', () => addSchedule(prefix));
  $(`#clear${cap}Button`).addEventListener('click', () => clearSchedule(prefix));

  if (ids.timeButton && ids.timePicker) {
    ids.timeButton.addEventListener('click', event => {
      event.stopPropagation();
      const opening = ids.timePicker.hidden;
      ['callback','preferred'].forEach(other => { if (other !== prefix) closeTimePicker(other); });
      ids.timePicker.hidden = !opening;
      ids.timeButton.setAttribute('aria-expanded', opening ? 'true' : 'false');
    });
    ids.timePicker.addEventListener('click', event => event.stopPropagation());
  }

  ids.month.addEventListener('change', () => {
    const oldMonth = Number(ids.month.dataset.previousMonth || ids.month.value);
    const newMonth = Number(ids.month.value);
    let year = Number(ids.year.value);

    // Scrolling December -> January means the next calendar year.
    if (oldMonth === 12 && newMonth === 1) year += 1;
    // And January -> December naturally goes back one year.
    else if (oldMonth === 1 && newMonth === 12) year -= 1;

    ensureYearOption(ids.year, year);
    ids.year.value = String(year);
    ids.month.dataset.previousMonth = String(newMonth);
    populateDayOptions(ids.day, year, newMonth, Number(ids.day.value));
    saveSchedule(prefix);
  });

  ids.year.addEventListener('change', () => {
    populateDayOptions(ids.day, Number(ids.year.value), Number(ids.month.value), Number(ids.day.value));
    saveSchedule(prefix);
  });
  ids.day.addEventListener('change', () => saveSchedule(prefix));
  ids.hour.addEventListener('change', () => saveSchedule(prefix));
  ids.minute.addEventListener('change', () => saveSchedule(prefix));
  ids.period.addEventListener('change', () => saveSchedule(prefix));
}

initializeScheduleDropdown('callback');
initializeScheduleDropdown('preferred');
bindScheduleEditor('callback');
bindScheduleEditor('preferred');

document.addEventListener('click', () => {
  closeTimePicker('callback');
  closeTimePicker('preferred');
  const picker = $('#specificTimePicker');
  if (picker) picker.hidden = true;
  $('#specificTimeButton')?.setAttribute('aria-expanded', 'false');
});


function openModal(id) {
  const modal = document.getElementById(id);
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeModal(id) {
  const modal = document.getElementById(id);
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 1600);
}

function escapeHTML(text) {
  return String(text ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
}

// Navigation / lists
$('#backButton').addEventListener('click', () => { renderLists(); showScreen('leads'); });
$('#leadSearch').addEventListener('input', renderLists);
$('#addLeadBottomButton').addEventListener('click', openNewLeadModal);
document.addEventListener('click', event => {
  const leadButton = event.target.closest('[data-open-lead]');
  if (leadButton) openLead(leadButton.dataset.openLead);
});

// Tabs
$$('.tab').forEach(tab => tab.addEventListener('click', () => setTab(tab.dataset.tab)));

// Single-select controls are true toggles: tapping the selected option again clears it.
$$('[data-field]').forEach(button => {
  button.addEventListener('click', () => {
    const lead = currentLead();
    if (!lead) return;
    const field = button.dataset.field;
    const value = button.dataset.value;
    const isAlreadySelected = lead[field] === value;
    const nextValue = isAlreadySelected ? '' : value;

    lead[field] = nextValue;
    $$(`[data-field="${field}"]`).forEach(item => {
      item.classList.toggle('selected', nextValue !== '' && item.dataset.value === nextValue);
    });

    if (field === 'timePreference') {
      const specific = nextValue === 'Specific Time';
      const control = $('#specificTimeControl');
      if (control) control.hidden = !specific;
      if (!specific) {
        lead.specificTime = '';
        loadSpecificTime('');
        const picker = $('#specificTimePicker');
        if (picker) picker.hidden = true;
        $('#specificTimeButton')?.setAttribute('aria-expanded', 'false');
      }
    }

    saveState();
  });
});


// Specific-time picker for General Availability
function initializeSpecificTimePicker() {
  const hour = $('#specificHour');
  const minute = $('#specificMinute');
  if (!hour || !minute) return;
  for (let h = 1; h <= 12; h++) hour.add(new Option(String(h), String(h)));
  ['00','15','30','45'].forEach(m => minute.add(new Option(m, m)));
}

function updateSpecificTimeDisplay() {
  const hour = $('#specificHour')?.value || '';
  const minute = $('#specificMinute')?.value || '';
  const period = $('#specificPeriod')?.value || '';
  const display = $('#specificTimeDisplay');
  if (!display) return;
  display.textContent = (hour && minute !== '' && period) ? `${pad2(hour)}:${minute} ${period}` : '00:00 AM';
}

function saveSpecificTime() {
  const lead = currentLead();
  if (!lead) return;
  const hour = Number($('#specificHour').value);
  const minute = $('#specificMinute').value;
  const period = $('#specificPeriod').value;
  if (hour && minute !== '' && period) {
    let hour24 = hour % 12;
    if (period === 'PM') hour24 += 12;
    lead.specificTime = `${pad2(hour24)}:${minute}`;
  } else {
    lead.specificTime = '';
  }
  updateSpecificTimeDisplay();
  saveState();
}

function loadSpecificTime(value) {
  const hour = $('#specificHour');
  const minute = $('#specificMinute');
  const period = $('#specificPeriod');
  if (!hour || !minute || !period) return;
  hour.value = ''; minute.value = ''; period.value = '';
  const match = /^(\d{1,2}):(\d{2})$/.exec(value || '');
  if (match) {
    const h24 = Number(match[1]);
    hour.value = String(h24 % 12 || 12);
    minute.value = ['00','15','30','45'].includes(match[2]) ? match[2] : '00';
    period.value = h24 >= 12 ? 'PM' : 'AM';
  }
  updateSpecificTimeDisplay();
}

initializeSpecificTimePicker();

$('#specificTimeButton')?.addEventListener('click', event => {
  event.stopPropagation();
  const picker = $('#specificTimePicker');
  const button = $('#specificTimeButton');
  const opening = picker.hidden;
  picker.hidden = !opening;
  button.setAttribute('aria-expanded', opening ? 'true' : 'false');
});
$('#specificTimePicker')?.addEventListener('click', event => event.stopPropagation());
['#specificHour','#specificMinute','#specificPeriod'].forEach(sel => $(sel)?.addEventListener('change', saveSpecificTime));

// Multi-select preferred days
$$('[data-multi="days"]').forEach(button => {
  button.addEventListener('click', () => {
    const lead = currentLead();
    if (!lead) return;
    lead.days ||= [];
    const value = button.dataset.value;
    lead.days = lead.days.includes(value) ? lead.days.filter(v => v !== value) : [...lead.days, value];
    button.classList.toggle('selected', lead.days.includes(value));
    saveState();
  });
});

// Text/select/date fields save on every change/input.
$$('[data-save]').forEach(element => {
  element.addEventListener('input', () => autosaveField(element));
  element.addEventListener('change', () => autosaveField(element));
});

// Quick Info tags: tapping any tag removes it from this lead and syncs the change.
$('#quickTagsList')?.addEventListener('click', event => {
  const chip = event.target.closest('[data-remove-tag-kind]');
  if (!chip) return;
  removeQuickInfoTag(chip.dataset.removeTagKind, chip.dataset.removeTagRaw || '');
});

// Quick Notes popup
$('#quickNotesButton').addEventListener('click', () => {
  $('#quickNotesInput').value = '';
  openModal('quickNotesModal');
  setTimeout(() => $('#quickNotesInput').focus(), 50);
});
$('#saveQuickNote').addEventListener('click', () => {
  const lead = currentLead();
  const note = $('#quickNotesInput').value.trim();
  if (!lead || !note) return toast('Type a note first');
  lead.notes = lead.notes ? `${lead.notes}\n${note}` : note;
  $('#notesField').value = lead.notes;
  saveState();
  closeModal('quickNotesModal');
  toast('Quick note added');
});

// Done -> choose label -> move to follow-ups
$('#doneButton').addEventListener('click', () => {
  const lead = currentLead();
  selectedDoneTag = '';
  selectedSpanishPossible = Boolean(lead?.spanishPossible);
  $$('.tag-choice[data-tag]').forEach(btn => btn.classList.remove('selected'));
  const spanishChoice = $('#spanishTagChoice');
  if (spanishChoice) spanishChoice.classList.toggle('selected', selectedSpanishPossible);
  $('#finishLeadButton').disabled = true;
  openModal('doneModal');
});
$$('.tag-choice[data-tag]').forEach(button => {
  button.addEventListener('click', () => {
    const value = button.dataset.tag;
    selectedDoneTag = selectedDoneTag === value ? '' : value;
    $$('.tag-choice[data-tag]').forEach(btn => {
      btn.classList.toggle('selected', selectedDoneTag !== '' && btn.dataset.tag === selectedDoneTag);
    });
    $('#finishLeadButton').disabled = !selectedDoneTag;
  });
});

const spanishTagChoice = $('#spanishTagChoice');
if (spanishTagChoice) {
  spanishTagChoice.addEventListener('click', () => {
    selectedSpanishPossible = !selectedSpanishPossible;
    spanishTagChoice.classList.toggle('selected', selectedSpanishPossible);
  });
}
async function finishLeadAndExit(tag = '') {
  const lead = currentLead();
  if (!lead) return;

  // A tag is optional. Clicking the X in the Done modal finishes the call
  // and moves the lead to Follow-ups without adding/changing a tag.
  if (tag) lead.tag = tag;
  lead.spanishPossible = selectedSpanishPossible;
  lead.status = 'followup';
  lead.lastCalled = new Date().toISOString();
  saveState(lead.id);

  try {
    await syncLeadNow(lead);
    showSyncStatus('Follow-up synced');
  } catch (error) {
    console.error('Could not move lead to Follow-ups in Supabase:', error);
    showSyncStatus('Sync failed');
  }

  closeModal('doneModal');
  renderLists();
  showScreen('leads');
  toast(tag ? `Moved to Follow-ups · ${tag}` : 'Moved to Follow-ups');
}

$('#finishLeadButton').addEventListener('click', async () => {
  if (!selectedDoneTag) return;
  await finishLeadAndExit(selectedDoneTag);
});

const doneModalCloseButton = $('#doneModal .modal-close');
if (doneModalCloseButton) {
  // Do not let the generic data-close handler also fire for this button.
  doneModalCloseButton.removeAttribute('data-close');
  doneModalCloseButton.addEventListener('click', async () => {
    await finishLeadAndExit('');
  });
}

// New lead + bulk JSON import
function setLeadEntryMode(mode) {
  const single = mode === 'single';
  $('#singleLeadTab').classList.toggle('active', single);
  $('#bulkLeadTab').classList.toggle('active', !single);
  $('#singleLeadPanel').classList.toggle('active', single);
  $('#bulkLeadPanel').classList.toggle('active', !single);
}

function openNewLeadModal() {
  ['newName','newCompany','newPhone','newSite','newAge','newIssue'].forEach(id => document.getElementById(id).value = '');
  $('#bulkLeadJson').value = '';
  $('#bulkLeadFile').value = '';
  $('#importStatus').textContent = '';
  $('#importStatus').className = 'import-status';
  setLeadEntryMode('single');
  openModal('newLeadModal');
  setTimeout(() => $('#newName').focus(), 50);
}

function makeLead(raw = {}) {
  const text = value => value == null ? '' : String(value).trim();
  return {
    id: crypto.randomUUID(),
    name: text(raw.name),
    company: text(raw.company ?? raw.companyName),
    phone: formatPhoneNumber(raw.phone ?? raw.phoneNumber),
    site: text(raw.site ?? raw.website ?? raw.url),
    age: text(raw.age ?? raw.siteAge),
    issue: text(raw.issue ?? raw.mainIssue),
    leadType: normalizeLeadType(raw.leadType ?? raw.type ?? raw.reason ?? (Array.isArray(raw.tags) ? raw.tags.find(tag => normalizeLeadType(tag) !== 'Spanish?') : '') ?? raw.issue ?? raw.mainIssue),
    tags: Array.isArray(raw.tags) ? raw.tags.map(text).filter(Boolean) : [],
    status: 'new',
    lastCalled: '',
    tag: '',
    spanishPossible: Boolean(raw.spanishPossible ?? raw.spanish ?? (Array.isArray(raw.tags) && raw.tags.some(tag => normalizeLeadType(tag) === 'Spanish?')) ?? false),
    answerStatus: '',
    mood: '',
    outcome: '',
    callbackDate: '',
    callbackTime: '',
    preferredContact: '',
    preferredDate: '',
    preferredTime: '',
    days: [],
    timePreference: '',
    specificTime: '',
    concerns: text(raw.concerns),
    notes: text(raw.notes)
  };
}

function normalizeLeadPhone(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function normalizeLeadText(value) {
  return String(value ?? '').trim().toLowerCase();
}

function isDuplicateLeadRaw(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;

  const rawId = normalizeLeadText(raw.id);
  if (rawId && state.leads.some(lead => normalizeLeadText(lead.id) === rawId)) return true;

  const rawPhone = normalizeLeadPhone(raw.phone ?? raw.phoneNumber);
  if (rawPhone && state.leads.some(lead => normalizeLeadPhone(lead.phone) === rawPhone)) return true;

  const rawName = normalizeLeadText(raw.name);
  const rawCompany = normalizeLeadText(raw.company ?? raw.companyName);
  const rawSite = normalizeLeadText(raw.site ?? raw.website ?? raw.url);

  if (rawName || rawCompany || rawSite) {
    return state.leads.some(lead =>
      normalizeLeadText(lead.name) === rawName &&
      normalizeLeadText(lead.company) === rawCompany &&
      normalizeLeadText(lead.site) === rawSite
    );
  }

  return false;
}

function mergeLeadRows(rows) {
  const imported = [];
  let skipped = 0;

  rows.forEach(row => {
    const raw = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
    if (isDuplicateLeadRaw(raw)) {
      skipped += 1;
      return;
    }

    const lead = makeLead(raw);
    state.leads.push(lead);
    imported.push(lead);
  });

  if (imported.length) saveState(...imported.map(lead => lead.id));
  return { imported, skipped };
}

async function loadLeadsJson() {
  try {
    const response = await fetch(`./leads.json?ts=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return;

    const parsed = await response.json();
    const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.leads) ? parsed.leads : null);
    if (!rows) {
      console.warn('leads.json must contain an array of leads, or an object with a leads array.');
      return;
    }

    const { imported } = mergeLeadRows(rows);
    if (imported.length) renderLists();
  } catch (error) {
    console.warn('Could not automatically load leads.json:', error);
  }
}


const newPhoneInput = $('#newPhone');
newPhoneInput.addEventListener('input', () => {
  const formatted = formatPhoneNumber(newPhoneInput.value);
  newPhoneInput.value = formatted;
});
newPhoneInput.addEventListener('keydown', event => {
  const allowed = ['Backspace','Delete','ArrowLeft','ArrowRight','Tab','Home','End'];
  if (allowed.includes(event.key) || event.metaKey || event.ctrlKey) return;
  if (!/^\d$/.test(event.key)) event.preventDefault();
});

$('#singleLeadTab').addEventListener('click', () => setLeadEntryMode('single'));
$('#bulkLeadTab').addEventListener('click', () => setLeadEntryMode('bulk'));

$('#createLeadButton').addEventListener('click', () => {
  const lead = makeLead({
    name: $('#newName').value,
    company: $('#newCompany').value,
    phone: $('#newPhone').value,
    site: $('#newSite').value,
    age: $('#newAge').value,
    issue: $('#newIssue').value
  });
  if (!lead.name) return toast('Add a lead name');
  state.leads.push(lead);
  saveState(lead.id);
  closeModal('newLeadModal');
  renderLists();
  toast('New lead added');
});

$('#bulkLeadFile').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    $('#bulkLeadJson').value = await file.text();
    $('#importStatus').textContent = `Loaded ${file.name}`;
    $('#importStatus').className = 'import-status success';
  } catch (_) {
    $('#importStatus').textContent = 'Could not read that file.';
    $('#importStatus').className = 'import-status error';
  }
});

$('#importLeadsButton').addEventListener('click', () => {
  const status = $('#importStatus');
  status.className = 'import-status';
  let parsed;
  try {
    parsed = JSON.parse($('#bulkLeadJson').value || '[]');
  } catch (error) {
    status.textContent = `Invalid JSON: ${error.message}`;
    status.classList.add('error');
    return;
  }

  const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.leads) ? parsed.leads : null);
  if (!rows) {
    status.textContent = 'JSON must be an array of leads, or an object with a leads array.';
    status.classList.add('error');
    return;
  }
  if (!rows.length) {
    status.textContent = 'The file has no lead rows to import.';
    status.classList.add('error');
    return;
  }

  // Import is append-only: existing leads are never replaced or modified.
  const { imported, skipped } = mergeLeadRows(rows);

  renderLists();
  closeModal('newLeadModal');

  if (skipped) {
    toast(`Imported ${imported.length} new lead${imported.length === 1 ? '' : 's'} · skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}`);
  } else {
    toast(`Imported ${imported.length} new lead${imported.length === 1 ? '' : 's'}`);
  }
});

// Generic modal close buttons / tapping backdrop
$$('[data-close]').forEach(button => button.addEventListener('click', () => closeModal(button.dataset.close)));
$$('.modal-backdrop').forEach(backdrop => {
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) closeModal(backdrop.id);
  });
});

renderLists();

$('#authSignIn').addEventListener('click', async () => {
  const email = $('#authEmail').value.trim();
  const password = $('#authPassword').value;
  const status = $('#authStatus');
  status.textContent = '';
  if (!email || !password) {
    status.textContent = 'Enter your email and password.';
    return;
  }
  $('#authSignIn').disabled = true;
  $('#authSignIn').textContent = 'Signing In…';
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  $('#authSignIn').disabled = false;
  $('#authSignIn').textContent = 'Sign In';
  if (error) {
    status.textContent = error.message;
    return;
  }
  supabaseSession = data.session;
  setAuthenticatedUi(true);
  try {
    await hydrateFromSupabase();
    await loadLeadsJson();
  } catch (syncError) {
    console.error(syncError);
    showSyncStatus('Sync failed');
  }
});

function passwordIsValid(password) {
  return typeof password === 'string' && password.length >= 8;
}

function currentRedirectUrl() {
  return `${window.location.origin}${window.location.pathname}`;
}

$('#forgotPasswordButton').addEventListener('click', async () => {
  const email = $('#authEmail').value.trim();
  const status = $('#authStatus');
  status.textContent = '';
  status.classList.remove('success');
  if (!email) {
    status.textContent = 'Enter your email first, then tap Forgot password.';
    return;
  }

  $('#forgotPasswordButton').disabled = true;
  $('#forgotPasswordButton').textContent = 'Sending…';
  const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
    redirectTo: currentRedirectUrl()
  });
  $('#forgotPasswordButton').disabled = false;
  $('#forgotPasswordButton').textContent = 'Forgot password?';

  if (error) {
    status.textContent = error.message;
    return;
  }
  status.classList.add('success');
  status.textContent = 'Password reset email sent. Check your inbox.';
});

$('#accountButton').addEventListener('click', async () => {
  const { data } = await supabaseClient.auth.getUser();
  $('#accountEmailDisplay').textContent = data.user?.email ? `Signed in as ${data.user.email}` : 'Signed in account';
  $('#accountNewPassword').value = '';
  $('#accountConfirmPassword').value = '';
  $('#accountPasswordStatus').textContent = '';
  $('#accountPasswordStatus').classList.remove('success');
  openModal('accountModal');
});

$('#changePasswordButton').addEventListener('click', async () => {
  const password = $('#accountNewPassword').value;
  const confirm = $('#accountConfirmPassword').value;
  const status = $('#accountPasswordStatus');
  status.textContent = '';
  status.classList.remove('success');

  if (!passwordIsValid(password)) {
    status.textContent = 'Password must be at least 8 characters.';
    return;
  }
  if (password !== confirm) {
    status.textContent = 'Passwords do not match.';
    return;
  }

  $('#changePasswordButton').disabled = true;
  $('#changePasswordButton').textContent = 'Saving…';
  const { error } = await supabaseClient.auth.updateUser({ password });
  $('#changePasswordButton').disabled = false;
  $('#changePasswordButton').textContent = 'Change Password';

  if (error) {
    status.textContent = error.message;
    return;
  }
  status.classList.add('success');
  status.textContent = 'Password changed successfully.';
  $('#accountNewPassword').value = '';
  $('#accountConfirmPassword').value = '';
});

$('#saveRecoveryPassword').addEventListener('click', async () => {
  const password = $('#recoveryNewPassword').value;
  const confirm = $('#recoveryConfirmPassword').value;
  const status = $('#recoveryPasswordStatus');
  status.textContent = '';
  status.classList.remove('success');

  if (!passwordIsValid(password)) {
    status.textContent = 'Password must be at least 8 characters.';
    return;
  }
  if (password !== confirm) {
    status.textContent = 'Passwords do not match.';
    return;
  }

  $('#saveRecoveryPassword').disabled = true;
  $('#saveRecoveryPassword').textContent = 'Saving…';
  const { error } = await supabaseClient.auth.updateUser({ password });
  $('#saveRecoveryPassword').disabled = false;
  $('#saveRecoveryPassword').textContent = 'Save New Password';

  if (error) {
    status.textContent = error.message;
    return;
  }

  status.classList.add('success');
  status.textContent = 'Password updated. Opening your leads…';
  setTimeout(() => {
    closeModal('passwordResetModal');
    setAuthenticatedUi(true);
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }, 700);
});

$('#signOutButton').addEventListener('click', async () => {
  $('#signOutButton').disabled = true;
  unsubscribeFromLeadChanges();
  await supabaseClient.auth.signOut();
  $('#signOutButton').disabled = false;
  closeModal('accountModal');
});

supabaseClient.auth.onAuthStateChange((event, session) => {
  supabaseSession = session;
  if (!session) unsubscribeFromLeadChanges();
  else if (event === 'SIGNED_IN') subscribeToLeadChanges();
  setAuthenticatedUi(Boolean(session));
  if (event === 'PASSWORD_RECOVERY') {
    $('#recoveryNewPassword').value = '';
    $('#recoveryConfirmPassword').value = '';
    $('#recoveryPasswordStatus').textContent = '';
    openModal('passwordResetModal');
  }
});

initializeSupabaseAuth().then(async () => {
  if (supabaseSession) await loadLeadsJson();
});

/* PULL TO REFRESH --------------------------------------------------------- */
(function setupPullToRefresh() {
  const threshold = 82;
  const maxPull = 126;
  let startY = 0;
  let pulling = false;
  let distance = 0;
  let refreshing = false;

  const indicator = document.createElement('div');
  indicator.className = 'pull-refresh-indicator';
  indicator.setAttribute('aria-hidden', 'true');
  indicator.innerHTML = '<i class="bi bi-arrow-down"></i>';
  document.body.appendChild(indicator);

  const icon = indicator.querySelector('i');

  function resetIndicator() {
    pulling = false;
    distance = 0;
    indicator.classList.remove('visible', 'ready');
    indicator.style.transform = 'translate(-50%, -58px) scale(.86)';
    icon.className = 'bi bi-arrow-down';
  }

  document.addEventListener('touchstart', event => {
    if (refreshing || event.touches.length !== 1) return;
    if (window.scrollY > 0 || document.documentElement.scrollTop > 0) return;
    if (document.querySelector('.modal-backdrop.open')) return;

    const target = event.target;
    if (target && target.closest('input, textarea, select, [contenteditable="true"]')) return;

    startY = event.touches[0].clientY;
    pulling = true;
    distance = 0;
  }, { passive: true });

  document.addEventListener('touchmove', event => {
    if (!pulling || refreshing || event.touches.length !== 1) return;
    const rawDistance = event.touches[0].clientY - startY;

    if (rawDistance <= 0) {
      resetIndicator();
      return;
    }

    // Rubber-band the movement so the indicator feels native instead of following 1:1.
    distance = Math.min(maxPull, rawDistance * .62);
    if (distance < 8) return;

    event.preventDefault();
    indicator.classList.add('visible');
    const y = Math.max(-42, Math.min(20, -42 + distance * .55));
    const scale = Math.min(1, .86 + distance / 520);
    indicator.style.transform = `translate(-50%, ${y}px) scale(${scale})`;

    const ready = distance >= threshold;
    indicator.classList.toggle('ready', ready);
    icon.className = ready ? 'bi bi-arrow-up' : 'bi bi-arrow-down';
  }, { passive: false });

  document.addEventListener('touchend', () => {
    if (!pulling || refreshing) return;
    const shouldRefresh = distance >= threshold;
    pulling = false;

    if (!shouldRefresh) {
      resetIndicator();
      return;
    }

    refreshing = true;
    indicator.classList.remove('ready');
    indicator.classList.add('visible', 'refreshing');
    icon.className = 'bi bi-arrow-clockwise';

    // Give the refresh animation a moment to appear, then perform a real page reload.
    setTimeout(() => window.location.reload(), 180);
  }, { passive: true });

  document.addEventListener('touchcancel', resetIndicator, { passive: true });
})();
