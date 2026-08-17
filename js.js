const SUPABASE_URL = 'https://eucaziymnjjpkbwbxwfj.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_ulLjvVJ81xRdSS_Wz9Qh4Q_nMSAlSfO';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
let supabaseSession = null;
let currentUserName = 'User';
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

}

function leadToSupabaseRow(lead) {
  ensureAutomaticTags(lead);
  return {
    id: lead.id,
    name: lead.name || '',
    company: lead.company || '',
    phone: lead.phone || '',
    email: lead.email || '',
    site: lead.site || '',
    lead_type: getLeadType(lead) || '',
    tags: Array.isArray(lead.tags) ? lead.tags : [],
    source_tags: Array.isArray(lead.sourceTags) ? lead.sourceTags.filter(tag => String(tag || '').trim().toLowerCase() !== 'other') : [],
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
    // Hot Lead is stored in the SQL `tags` array. Keep it out of the legacy
    // single-value `tag` column so older Supabase constraints cannot reject
    // the whole upsert. The UI reads priority tags from both `tag` and `tags`.
    tag: String(lead.tag || '').trim().toLowerCase() === 'hot lead'
      ? ((Array.isArray(lead.tags) ? lead.tags : [])
          .map(tag => String(tag || '').trim())
          .find(tag => tag && tag.toLowerCase() !== 'hot lead' && FOLLOWUP_TAGS.has(tag)) || '')
      : (lead.tag || ''),
    last_called: lead.lastCalled || null,
    history: Array.isArray(lead.history) ? lead.history : [],
    sold_by: lead.soldBy || '',
    updated_at: new Date().toISOString()
  };
}

function supabaseRowToLead(row, status = 'new') {
  return ensureAutomaticTags({
    id: row.id,
    name: row.name || '',
    company: row.company || '',
    phone: row.phone || '',
    email: row.email || '',
    site: row.site || '',
    age: row.age || '',
    issue: row.issue || '',
    leadType: row.lead_type || '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    sourceTags: Array.isArray(row.source_tags) ? row.source_tags.filter(tag => String(tag || '').trim().toLowerCase() !== 'other') : [],
    spanishPossible: Boolean(row.spanish_possible),
    status,
    lastCalled: row.last_called || '',
    createdAt: row.created_at || '',
    history: Array.isArray(row.history) ? row.history : [],
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
    notes: row.notes || '',
    soldBy: row.sold_by || ((Array.isArray(row.history) ? row.history : []).slice().reverse().find(item => item?.type === 'sold')?.actor || '')
  });
}

function tableForLead(lead) {
  if (lead?.status === 'sold') return 'sold_leads';
  return lead?.status === 'followup' ? 'follow_ups' : 'new_leads';
}

function otherTablesForLead(lead) {
  return ['new_leads', 'follow_ups', 'sold_leads'].filter(table => table !== tableForLead(lead));
}

function soldPublicRow(lead) {
  return { ...leadToSupabaseRow(lead), phone: '' };
}

async function storeSoldPhoneSecurely(lead) {
  if (!lead || lead.status !== 'sold') return;
  const { error } = await supabaseClient.rpc('store_sold_phone', {
    p_lead_id: lead.id,
    p_phone: lead.phone || ''
  });
  if (error) throw error;
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
  const newLeads = leads.filter(lead => lead.status === 'new');
  const followLeads = leads.filter(lead => lead.status === 'followup');
  const soldLeads = leads.filter(lead => lead.status === 'sold');

  const groups = [
    ['new_leads', newLeads, leadToSupabaseRow],
    ['follow_ups', followLeads, leadToSupabaseRow],
    ['sold_leads', soldLeads, soldPublicRow]
  ];

  for (const [table, group, mapper] of groups) {
    if (!group.length) continue;
    const rows = group.map(mapper);
    const { error } = await supabaseClient.from(table).upsert(rows, { onConflict: 'id' });
    if (error) throw error;
    const ids = rows.map(row => row.id);
    for (const otherTable of ['new_leads', 'follow_ups', 'sold_leads'].filter(name => name !== table)) {
      const { error: cleanupError } = await supabaseClient.from(otherTable).delete().in('id', ids);
      if (cleanupError) throw cleanupError;
    }
  }

  for (const lead of soldLeads) await storeSoldPhoneSecurely(lead);
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
  const row = lead.status === 'sold' ? soldPublicRow(lead) : leadToSupabaseRow(lead);
  const { error } = await supabaseClient.from(table).upsert(row, { onConflict: 'id' });
  if (error) throw error;
  for (const otherTable of otherTablesForLead(lead)) {
    const { error: cleanupError } = await supabaseClient.from(otherTable).delete().eq('id', lead.id);
    if (cleanupError) throw cleanupError;
  }
  if (lead.status === 'sold') await storeSoldPhoneSecurely(lead);
}

async function syncLeadTagsOnly(lead) {
  if (!supabaseSession || !lead) return;

  const table = tableForLead(lead);
  const tags = Array.isArray(lead.tags)
    ? [...new Set(lead.tags.map(tag => String(tag || '').trim()).filter(Boolean))]
    : [];

  const { data, error } = await supabaseClient
    .from(table)
    .update({ tags })
    .eq('id', lead.id)
    .select('id,tags')
    .single();

  if (error) throw error;

  const savedTags = Array.isArray(data?.tags) ? data.tags : [];
  lead.tags = savedTags;
  return savedTags;
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
    // sold_leads never contains the private phone. Preserve Kiara's already-loaded
    // private copy when realtime updates the public sold record.
    if (status === 'sold' && currentUserIsKiara() && index >= 0 && state.leads[index].phone && !incoming.phone) {
      incoming.phone = state.leads[index].phone;
    }
    if (index >= 0) state.leads[index] = incoming;
    else state.leads.push(incoming);
  }

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
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sold_leads' }, payload => applyRealtimeLeadChange(payload, 'sold'))
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

  const [newResult, followResult, soldResult] = await Promise.all([
    supabaseClient.from('new_leads').select('*').order('created_at', { ascending: true }),
    supabaseClient.from('follow_ups').select('*').order('created_at', { ascending: true }),
    supabaseClient.from('sold_leads').select('*').order('created_at', { ascending: true })
  ]);

  if (newResult.error) throw newResult.error;
  if (followResult.error) throw followResult.error;
  if (soldResult.error) throw soldResult.error;

  const remoteLeads = [
    ...(newResult.data || []).map(row => supabaseRowToLead(row, 'new')),
    ...(followResult.data || []).map(row => supabaseRowToLead(row, 'followup')),
    ...(soldResult.data || []).map(row => supabaseRowToLead(row, 'sold'))
  ];

  if (currentUserIsKiara()) {
    const { data: privatePhones, error: privateError } = await supabaseClient
      .from('sold_private_phones')
      .select('lead_id, phone');
    if (privateError) console.error('Could not load Kiara-only sold phone numbers:', privateError);
    else {
      const phoneById = new Map((privatePhones || []).map(row => [row.lead_id, row.phone || '']));
      remoteLeads.forEach(lead => {
        if (lead.status === 'sold' && phoneById.has(lead.id)) lead.phone = phoneById.get(lead.id);
      });
    }
  }

  const systemNoteLeads = remoteLeads.filter(addInitialSystemNoteHistory);
  if (systemNoteLeads.length) await upsertLeadsByTable(systemNoteLeads);

  state.leads = remoteLeads;
  renderLists();
  const savedPage = loadPageState();
  if (savedPage.screen === 'detail' && savedPage.leadId && state.leads.some(lead => lead.id === savedPage.leadId)) {
    currentLeadId = savedPage.leadId;
    renderCurrentLead();
    setTab(savedPage.tab || 'detailsPanel');
    showScreen('detail');
  }
}

function getUserDisplayName(session = supabaseSession) {
  const user = session?.user;
  if (!user) return 'User';
  const meta = user.user_metadata || {};
  const candidate = meta.display_name || meta.full_name || meta.name || meta.user_name || meta.username;
  if (candidate && String(candidate).trim()) return String(candidate).trim();
  if (user.email) return String(user.email).split('@')[0];
  return 'User';
}

function updateSignedInUserUi() {
  currentUserName = getUserDisplayName();
  const el = document.getElementById('signedInUserName');
  if (el) el.textContent = currentUserName;
  const accountName = document.getElementById('accountUserName');
  if (accountName) accountName.textContent = currentUserName;
  document.querySelectorAll('.script-user-name').forEach(el => {
    el.textContent = currentUserName;
  });
}

function currentUserIsKiara() {
  const email = String(supabaseSession?.user?.email || '').trim().toLowerCase();
  return email === 'kiara@steadyhandsop.com';
}

function addLeadHistory(lead, type, actor = currentUserName, at = new Date().toISOString(), details = {}) {
  if (!lead) return;
  if (!Array.isArray(lead.history)) lead.history = [];
  lead.history.push({
    id: crypto.randomUUID(),
    type,
    actor: String(actor || 'User').trim() || 'User',
    at,
    ...details
  });
}

function activeUserName() {
  const fromUi = String(currentUserName || '').trim();
  if (fromUi && !['user', 'unknown'].includes(fromUi.toLowerCase())) return fromUi;
  const email = String(supabaseSession?.user?.email || '').trim();
  if (email) return email.split('@')[0] || email;
  return fromUi || 'User';
}

function latestSoldActor(lead) {
  if (!Array.isArray(lead?.history)) return '';
  const item = [...lead.history].reverse().find(entry => entry?.type === 'sold' && String(entry?.actor || '').trim());
  return String(item?.actor || '').trim();
}

function addInitialSystemNoteHistory(lead) {
  if (!lead || !String(lead.notes || '').trim()) return false;
  if (!Array.isArray(lead.history)) lead.history = [];

  let changed = false;
  const currentNotes = String(lead.notes || '').trim();
  const existingSystemEntry = lead.history.find(item =>
    item?.type === 'note' && item?.initial === true && String(item?.actor || '').toLowerCase() === 'system'
  );

  // Notes that arrive with the original Supabase/import row are system notes.
  // Prefix the Notes field itself so the attribution is visible even before
  // opening History. Do this only once.
  if (existingSystemEntry) {
    if (!/^System:\s*/i.test(currentNotes)) {
      lead.notes = `System: ${currentNotes}`;
      changed = true;
    }
    return changed;
  }

  // Only create an initial System history event when there is no other history.
  if (lead.history.length) return changed;

  const rawNote = currentNotes.replace(/^System:\s*/i, '').trim();
  lead.notes = `System: ${rawNote}`;
  addLeadHistory(
    lead,
    'note',
    'System',
    lead.createdAt || new Date().toISOString(),
    { note: rawNote, initial: true }
  );
  return true;
}

function formatHistoryMoment(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const datePart = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
  const timePart = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  return `${datePart} at ${timePart}`;
}

function historyText(item) {
  if (!item) return '';
  const actor = item.actor || 'User';
  const when = formatHistoryMoment(item.at);
  if (item.type === 'called') return `Called by ${actor}${when ? ` on ${when}` : ''}`;
  if (item.type === 'added') return `Lead added by ${actor}${when ? ` on ${when}` : ''}`;
  if (item.type === 'note') return `Note added by ${actor}${when ? ` on ${when}` : ''}${item.note ? ` — \"${item.note}\"` : ''}`;
  if (item.type === 'sold') return `Sold by ${actor}${when ? ` on ${when}` : ''}`;
  return `${item.label || 'Updated'} by ${actor}${when ? ` on ${when}` : ''}`;
}

function latestLeadHistory(lead) {
  const items = Array.isArray(lead?.history) ? lead.history : [];
  return items.length ? items[items.length - 1] : null;
}

function latestCallHistory(lead) {
  const items = Array.isArray(lead?.history) ? lead.history : [];
  const calls = items.filter(item => item?.type === 'called');
  if (!calls.length) return null;
  return calls.slice().sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0)).pop();
}

function callerSummary(lead, includeTime = false) {
  const call = latestCallHistory(lead);
  if (!call) return 'Not called yet';
  const actor = String(call.actor || 'User').trim() || 'User';
  if (!includeTime) return `Called by ${actor}`;
  const when = formatHistoryMoment(call.at);
  return `Called by ${actor}${when ? ` · ${when}` : ''}`;
}

function updateHistoryVisibility() {
  const list = document.getElementById('leadHistoryList');
  const button = document.getElementById('historyToggleButton');
  if (!list || !button) return;
  list.hidden = !historyExpanded;
  button.setAttribute('aria-expanded', String(historyExpanded));
  button.classList.toggle('open', historyExpanded);
}

function renderLeadHistory() {
  updateHistoryVisibility();
  const lead = currentLead();
  const list = document.getElementById('leadHistoryList');
  if (!lead || !list) return;
  const items = Array.isArray(lead.history) ? lead.history.slice().reverse() : [];
  if (!items.length) {
    list.innerHTML = '<div class="history-empty">No history available.</div>';
    return;
  }
  const canDeleteHistory = currentUserIsKiara();
  list.innerHTML = items.map(item => {
    const dotClass = item.type === 'called' ? 'called' : item.type === 'note' ? 'note' : item.type === 'sold' ? 'sold' : 'added';
    const iconClass = item.type === 'called' ? 'bi-telephone-fill' : item.type === 'note' ? 'bi-journal-text' : item.type === 'sold' ? 'bi-trophy-fill' : 'bi-person-plus-fill';
    const title = item.type === 'called' ? 'Called' : item.type === 'added' ? 'Lead added' : item.type === 'note' ? 'Note added' : item.type === 'sold' ? `Sold by ${escapeHTML(item.actor || 'Unknown')}` : (item.label || 'Updated');
    const noteText = item.type === 'note' && item.note ? `<p class="history-note-text">${escapeHTML(item.note)}</p>` : '';
    const deleteButton = canDeleteHistory && (item.type === 'note' || item.type === 'called')
      ? `<button class="history-note-delete" type="button" data-delete-history="${escapeHTML(item.id || '')}" aria-label="Delete ${item.type === 'called' ? 'call log' : 'note'}" title="Delete ${item.type === 'called' ? 'call log' : 'note'}"><i class="bi bi-x-lg"></i></button>`
      : '';
    return `
      <div class="history-item">
        <span class="history-dot ${dotClass}"><i class="bi ${iconClass}"></i></span>
        <div class="history-item-content"><strong>${escapeHTML(title)}</strong>
        <span>${escapeHTML(item.actor || 'User')} · ${escapeHTML(formatHistoryMoment(item.at))}</span>${noteText}</div>
        ${deleteButton}
      </div>`;
  }).join('');
}

function removeNoteTextFromLead(lead, noteText) {
  const note = String(noteText || '').trim();
  if (!lead || !note) return;
  const current = String(lead.notes || '');
  if (!current.trim()) return;

  const lines = current.split('\n');
  const possibleNotes = [note, `System: ${note}`];
  const exactIndex = lines.findIndex(line => possibleNotes.some(candidate => line.trim() === candidate));
  if (exactIndex >= 0) {
    lines.splice(exactIndex, 1);
    lead.notes = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return;
  }

  const systemNote = `System: ${note}`;
  const target = current.includes(systemNote) ? systemNote : note;
  const index = current.indexOf(target);
  if (index >= 0) {
    lead.notes = (current.slice(0, index) + current.slice(index + target.length))
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s*\n|\n\s*$/g, '')
      .trim();
  }
}

async function deleteHistoryEntry(historyId) {
  if (!currentUserIsKiara()) return toast('Only Kiara can delete history entries');
  const lead = currentLead();
  if (!lead || !historyId) return;
  const item = (lead.history || []).find(entry => entry.id === historyId);
  if (!item || !['note', 'called'].includes(item.type)) return;

  if (item.type === 'note') {
    removeNoteTextFromLead(lead, item.note || '');
    }

  lead.history = (lead.history || []).filter(entry => entry.id !== historyId);

  // If a call log was removed, keep lastCalled consistent with the newest
  // remaining call history entry. If no call logs remain, clear it.
  if (item.type === 'called') {
    const remainingCalls = (lead.history || [])
      .filter(entry => entry.type === 'called' && entry.at)
      .sort((a, b) => new Date(a.at) - new Date(b.at));
    lead.lastCalled = remainingCalls.length ? remainingCalls[remainingCalls.length - 1].at : '';

  }

  saveState(lead.id);
  renderLeadHistory();
  renderLists();
  try {
    await syncLeadNow(lead);
    showSyncStatus(item.type === 'called' ? 'Call log deleted' : 'Note deleted');
  } catch (error) {
    console.error('Could not delete history entry in Supabase:', error);
    showSyncStatus('Sync failed');
  }
}

function setAuthenticatedUi(isAuthenticated) {
  document.getElementById('authGate').hidden = isAuthenticated;
  document.getElementById('appShell').hidden = !isAuthenticated;
  if (isAuthenticated) updateSignedInUserUi();
}

async function initializeSupabaseAuth() {
  const { data } = await supabaseClient.auth.getSession();
  supabaseSession = data.session || null;
  setAuthenticatedUi(Boolean(supabaseSession));
  if (supabaseSession) {
    try { await hydrateFromSupabase(); subscribeToLeadChanges(); } catch (error) { console.error(error); showSyncStatus('Sync failed'); }
  }
}

const PAGE_STATE_KEY = 'steadyHandsLeadApp_pageState_v1';

const seedLeads = [];

let state = loadState();
let currentLeadId = null;
let editingLeadId = null;
let editingLeadStatusId = null;
let selectedDoneTag = '';
let selectedSpanishPossible = false;

function loadPageState() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(PAGE_STATE_KEY) || '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch (_) {
    return {};
  }
}

function savePageState(patch = {}) {
  const current = loadPageState();
  const next = { ...current, ...patch };
  sessionStorage.setItem(PAGE_STATE_KEY, JSON.stringify(next));
  return next;
}

function clearDetailPageState() {
  savePageState({ screen: 'leads', leadId: null, tab: 'detailsPanel' });
}

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function loadState() {
  // Supabase is the only persistent source of truth.
  return { leads: structuredClone(seedLeads) };
}

function saveState(...leadIds) {
  const ids = leadIds.filter(Boolean);
  if (ids.length) queueLeadSync(...ids);
  else if (currentLeadId) queueLeadSync(currentLeadId);
  else queueAllLeadSync();
}


function formatPhoneNumber(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  // If a US number is pasted with +1 / leading 1, keep the local 10-digit format.
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  digits = digits.slice(0, 10);
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
  const leadsScreen = $('#leadsScreen');
  const detailScreen = $('#detailScreen');
  const showingDetail = name === 'detail';

  savePageState({
    screen: showingDetail ? 'detail' : 'leads',
    leadId: showingDetail ? currentLeadId : null
  });

  leadsScreen.classList.toggle('active', !showingDetail);
  detailScreen.classList.toggle('active', showingDetail);

  // Force a true one-screen-at-a-time layout on desktop too.
  // This prevents older desktop CSS from keeping the lead board visible.
  if (showingDetail) {
    leadsScreen.style.setProperty('display', 'none', 'important');
    detailScreen.style.removeProperty('display');
    leadsScreen.setAttribute('aria-hidden', 'true');
    detailScreen.removeAttribute('aria-hidden');
  } else {
    detailScreen.style.setProperty('display', 'none', 'important');
    leadsScreen.style.removeProperty('display');
    detailScreen.setAttribute('aria-hidden', 'true');
    leadsScreen.removeAttribute('aria-hidden');
  }

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

function getActiveSiteTag(lead) {
  if (!lead) return '';
  const siteTags = Array.isArray(lead.tags)
    ? lead.tags.map(normalizeLeadType).filter(tag => LEAD_TYPE_TAGS.has(tag))
    : [];

  // Prefer the explicit currently selected leadType when it is a website tag.
  const explicit = normalizeLeadType(lead.leadType);
  if (LEAD_TYPE_TAGS.has(explicit)) return explicit;

  return siteTags[0] || '';
}

function getLeadType(lead) {
  const activeSite = getActiveSiteTag(lead);
  if (activeSite) return activeSite;

  const fallback = normalizeLeadType(lead?.type || lead?.reason || '');
  return LEAD_TYPE_TAGS.has(fallback) ? fallback : fallback;
}

function hasPossibleSpanishTag(lead) {
  return Boolean(lead.spanishPossible) || (Array.isArray(lead.tags) && lead.tags.some(tag => normalizeLeadType(tag) === 'Spanish?'));
}

const AVAILABLE_LEAD_TAGS = [
  'No Site',
  'Broken Site',
  'Outdated Site',
  'Spanish?',
  'No Phone',
  'Hot Lead',
  'Interested',
  'Call Back',
  'Needs More Info',
  'Skeptical',
  'No Answer',
  'Not Interested',
  'Wrong Number',
  'Sold'
];

const LEAD_TAG_GROUPS = [
  {
    key: 'site',
    title: 'Website',
    description: 'Optional — choose one, switch it, or leave blank',
    tags: ['No Site', 'Broken Site', 'Outdated Site']
  },
  {
    key: 'contact',
    title: 'Contact',
    description: 'Language and contact limitations',
    tags: ['Spanish?', 'No Phone']
  },
  {
    key: 'interest',
    title: 'Lead Status',
    description: 'Interest and next-step signals',
    tags: ['Hot Lead', 'Interested', 'Call Back', 'Needs More Info', 'Skeptical']
  },
  {
    key: 'outcome',
    title: 'Call Outcome',
    description: 'Negative or unreachable outcomes',
    tags: ['No Answer', 'Not Interested', 'Wrong Number']
  },
  {
    key: 'conversion',
    title: 'Conversion',
    description: 'Completed sales',
    tags: ['Sold']
  }
];

const LEAD_TAG_GROUP_BY_LABEL = Object.fromEntries(
  LEAD_TAG_GROUPS.flatMap(group => group.tags.map(tag => [tag, group.key]))
);

const LEAD_TAG_ICONS = {
  'No Site': 'bi-globe2',
  'Outdated Site': 'bi-clock-history',
  'Broken Site': 'bi-exclamation-triangle',
  'Spanish?': 'bi-translate',
  'No Phone': 'bi-telephone-x',
  'Hot Lead': 'bi-fire',
  'Interested': 'bi-star',
  'Call Back': 'bi-telephone-forward',
  'Needs More Info': 'bi-info-circle',
  'No Answer': 'bi-phone-vibrate',
  'Skeptical': 'bi-question-circle',
  'Not Interested': 'bi-slash-circle',
  'Wrong Number': 'bi-exclamation-octagon',
  'Sold': 'bi-trophy'
};

const SOURCE_TAG_META = {
  'Google': { icon: 'bi-google', className: 'source-google' },
  'Google Maps': { icon: 'bi-geo-alt-fill', className: 'source-google-maps' },
  'Yelp': { icon: 'bi-star-fill', className: 'source-yelp' },
  'Facebook': { icon: 'bi-facebook', className: 'source-facebook' },
  'Instagram': { icon: 'bi-instagram', className: 'source-instagram' },
  'Nextdoor': { icon: 'bi-houses-fill', className: 'source-nextdoor' },
  'Facebook Marketplace': { icon: 'bi-shop', className: 'source-facebook-marketplace' },
  'TikTok': { icon: 'bi-tiktok', className: 'source-tiktok' },
  'Reddit': { icon: 'bi-reddit', className: 'source-reddit' },
  'Threads': { icon: 'bi-at', className: 'source-threads' },
  'LinkedIn': { icon: 'bi-linkedin', className: 'source-linkedin' },
  'X / Twitter': { icon: 'bi-twitter-x', className: 'source-x' },
  'OfferUp': { icon: 'bi-bag-fill', className: 'source-offerup' },
  'Other': { icon: 'bi-three-dots', className: 'source-other' }
};


function getSourceTagMeta(label) {
  const clean = String(label || '').trim();
  // Built-in sources use their brand-inspired style. Anything entered through
  // “Other” is a lead-specific custom source and MUST keep its exact label.
  return SOURCE_TAG_META[clean] || { icon: 'bi-link-45deg', className: 'source-custom' };
}

const LEAD_TYPE_TAGS = new Set(['Outdated Site', 'No Site', 'Broken Site']);
const FOLLOWUP_TAGS = new Set(['Hot Lead', 'Interested', 'Needs More Info', 'Skeptical', 'Call Back', 'No Answer', 'Wrong Number', 'Not Interested', 'Sold']);

const POPULAR_SOURCE_TAGS = [
  'Google',
  'Google Maps',
  'Yelp',
  'Facebook',
  'Instagram',
  'Nextdoor'
];

const MORE_SOURCE_TAGS = [
  'Facebook Marketplace',
  'TikTok',
  'Reddit',
  'Threads',
  'LinkedIn',
  'X / Twitter',
  'OfferUp',
  'Other'
];

const AVAILABLE_SOURCE_TAGS = [...POPULAR_SOURCE_TAGS, ...MORE_SOURCE_TAGS];
const REMOVED_SOURCE_TAGS = new Set([
  'booksy', 'books', 'craigslist', 'thumbtack', 'angi', 'yellow pages',
  'taskrabbit', 'task rabbit', 'bark', 'styleseat', 'style seat', 'fresha',
  'fresh', 'vagaro', 'vagary', 'square', 'business license', 'news listing',
  'directory', 'salon directory', 'bbb', 'simpletire', 'simple tire',
  'roadtrippers', 'road trippers', 'fmcsa', 'website'
]);
let sourceTagsExpanded = false;

function renderSourceTags() {
  const lead = currentLead();
  const list = $('#sourceTagsList');
  const expandButton = $('#sourceTagsExpandButton');
  if (!lead || !list) return;

  lead.sourceTags = Array.isArray(lead.sourceTags) ? lead.sourceTags : [];
  // Removed options stay hidden even if an older database row still contains them.
  // Literal "Other" is never a saved/selected source. It is only the button that opens custom source entry.
  lead.sourceTags = lead.sourceTags.filter(tag => String(tag || '').trim().toLowerCase() !== 'other');
  const visibleStoredTags = lead.sourceTags.filter(tag => !REMOVED_SOURCE_TAGS.has(String(tag || '').trim().toLowerCase()));
  const selectedKeys = new Set(visibleStoredTags.map(tag => String(tag || '').trim().toLowerCase()).filter(Boolean));
  const builtInKeys = new Set(AVAILABLE_SOURCE_TAGS.map(tag => tag.toLowerCase()));
  const custom = visibleStoredTags.filter(tag => !builtInKeys.has(String(tag || '').trim().toLowerCase()));

  // Custom sources created through “Other” belong only to this lead. They are
  // read from lead.sourceTags and are never added to AVAILABLE_SOURCE_TAGS.
  // Selected/checkmarked sources always render first.
  let all;
  if (sourceTagsExpanded) {
    all = [...AVAILABLE_SOURCE_TAGS, ...custom];
  } else {
    // Keep popular choices visible while always surfacing every selected extra/custom source.
    const selectedExtras = [...MORE_SOURCE_TAGS, ...custom].filter(tag => selectedKeys.has(tag.toLowerCase()));
    all = [...POPULAR_SOURCE_TAGS, ...selectedExtras];
  }
  all = [...new Set(all)];
  all.sort((a, b) => {
    const aSelected = selectedKeys.has(String(a).toLowerCase()) ? 1 : 0;
    const bSelected = selectedKeys.has(String(b).toLowerCase()) ? 1 : 0;
    return bSelected - aSelected;
  });

  list.innerHTML = all.map(label => {
    const selected = selectedKeys.has(label.toLowerCase());
    const meta = getSourceTagMeta(label);
    return `<button class="quick-tag-chip source-tag-chip ${meta.className}${selected ? ' selected' : ''}" type="button" data-toggle-source-tag="${escapeHTML(label)}" aria-pressed="${selected ? 'true' : 'false'}"><i class="bi ${meta.icon}" aria-hidden="true"></i><span>${escapeHTML(label === 'Other' ? 'Other…' : label)}</span>${selected ? '<i class="bi bi-check-lg source-check" aria-hidden="true"></i>' : ''}</button>`;
  }).join('');

  if (expandButton) {
    expandButton.innerHTML = sourceTagsExpanded
      ? '<span>Show Less</span><i class="bi bi-chevron-up"></i>'
      : `<span>More Sources</span><i class="bi bi-chevron-down"></i>`;
    expandButton.setAttribute('aria-expanded', sourceTagsExpanded ? 'true' : 'false');
  }
}

async function toggleSourceTag(label) {
  const lead = currentLead();
  if (!lead) return;
  const clean = String(label || '').trim();
  if (!clean) return;
  lead.sourceTags = Array.isArray(lead.sourceTags) ? lead.sourceTags : [];
  const key = clean.toLowerCase();
  if (key === 'other') return; // “Other” is an entry action, never a saved source value.
  const exists = lead.sourceTags.some(tag => String(tag || '').trim().toLowerCase() === key);
  if (exists) lead.sourceTags = lead.sourceTags.filter(tag => String(tag || '').trim().toLowerCase() !== key);
  else lead.sourceTags.push(clean);
  saveState(lead.id);
  renderSourceTags();
  try {
    await syncLeadNow(lead);
    showSyncStatus(exists ? 'Source removed' : 'Source added');
  } catch (error) {
    console.error('Could not sync source tags:', error);
    showSyncStatus('Sync failed');
  }
}

function ensureNoSiteTag(lead) {
  if (!lead) return lead;
  lead.tags = Array.isArray(lead.tags) ? lead.tags : [];

  // Website-condition tags are now completely user-controlled.
  // A lead is allowed to have NO website-condition tag selected.
  // We only normalize old data so at most one of the three site tags survives.
  const selectedSiteTags = lead.tags
    .map(tag => normalizeLeadType(tag))
    .filter(tag => LEAD_TYPE_TAGS.has(tag));

  const explicit = normalizeLeadType(lead.leadType);
  const keep = LEAD_TYPE_TAGS.has(explicit) ? explicit : (selectedSiteTags[0] || '');

  lead.tags = lead.tags.filter(tag => !LEAD_TYPE_TAGS.has(normalizeLeadType(tag)));
  if (keep) lead.tags.push(keep);

  if (!keep && LEAD_TYPE_TAGS.has(explicit)) lead.leadType = '';
  if (keep) lead.leadType = keep;

  return lead;
}

function ensureNoPhoneTag(lead) {
  if (!lead) return lead;
  lead.tags = Array.isArray(lead.tags) ? lead.tags : [];
  const hasPhone = Boolean(String(lead.phone || '').replace(/\D/g, ''));
  const hasNoPhone = lead.tags.some(tag => String(tag || '').trim().toLowerCase() === 'no phone');

  if (!hasPhone && !hasNoPhone) lead.tags.push('No Phone');
  if (hasPhone && hasNoPhone) lead.tags = lead.tags.filter(tag => String(tag || '').trim().toLowerCase() !== 'no phone');
  return lead;
}

function ensureAutomaticTags(lead) {
  ensureNoSiteTag(lead);
  ensureNoPhoneTag(lead);
  return lead;
}

function selectedLeadTags(lead) {
  ensureAutomaticTags(lead);
  const selected = new Map();
  const add = value => {
    const clean = String(value || '').trim();
    if (!clean) return;
    selected.set(normalizeLeadType(clean).toLowerCase(), clean);
  };

  if (Array.isArray(lead.tags)) lead.tags.forEach(add);
  const leadType = getLeadType(lead);
  if (leadType) add(leadType);
  if (hasPossibleSpanishTag(lead)) add('Spanish?');
  if (lead.tag) add(lead.tag);
  return selected;
}

function renderQuickInfoTags() {
  const lead = currentLead();
  const list = $('#quickTagsList');
  if (!lead || !list) return;

  const selected = selectedLeadTags(lead);
  const knownKeys = new Set(AVAILABLE_LEAD_TAGS.map(tag => normalizeLeadType(tag).toLowerCase()));
  const customTags = Array.from(selected.values())
    .filter(tag => !knownKeys.has(normalizeLeadType(tag).toLowerCase()));

  const renderChip = (label, groupKey = 'custom') => {
    const key = normalizeLeadType(label).toLowerCase();
    const isSelected = selected.has(key);
    const normalizedLabel = normalizeLeadType(label);
    const icon = LEAD_TAG_ICONS[normalizedLabel] || 'bi-tag';
    const isSiteChoice = LEAD_TYPE_TAGS.has(normalizedLabel);

    return `
      <button
        class="quick-tag-chip lead-tag-option tag-group-${escapeHTML(groupKey)}${isSelected ? ' selected' : ''}"
        type="button"
        data-toggle-lead-tag="${escapeHTML(label)}"
        data-tag-group="${escapeHTML(groupKey)}"
        aria-pressed="${isSelected ? 'true' : 'false'}"
        ${isSiteChoice ? 'role="radio"' : ''}
        ${isSiteChoice ? `aria-checked="${isSelected ? 'true' : 'false'}"` : ''}
        aria-label="${isSiteChoice ? 'Select' : (isSelected ? 'Remove' : 'Add')} ${escapeHTML(label)} tag">
        <i class="bi ${icon}" aria-hidden="true"></i>
        <span>${escapeHTML(label)}</span>
        ${isSelected ? '<i class="bi bi-check-lg tag-state-check" aria-hidden="true"></i>' : ''}
      </button>`;
  };

  const groupHtml = LEAD_TAG_GROUPS.map(group => {
    const chips = group.tags.map(label => renderChip(label, group.key)).join('');
    return `
      <section class="lead-tag-group lead-tag-group-${escapeHTML(group.key)}">
        <div class="lead-tag-group-heading">
          <div>
            <strong>${escapeHTML(group.title)}</strong>
            <small>${escapeHTML(group.description)}</small>
          </div>
        </div>
        <div class="lead-tag-group-options" ${group.key === 'site' ? 'role="radiogroup" aria-label="Website condition"' : ''}>
          ${chips}
        </div>
      </section>`;
  }).join('');

  const customHtml = customTags.length
    ? `
      <section class="lead-tag-group lead-tag-group-custom">
        <div class="lead-tag-group-heading">
          <div>
            <strong>Other</strong>
            <small>Custom tags on this lead</small>
          </div>
        </div>
        <div class="lead-tag-group-options">
          ${customTags.map(label => renderChip(label, 'custom')).join('')}
        </div>
      </section>`
    : '';

  list.innerHTML = groupHtml + customHtml;
}

async function toggleQuickInfoTag(label) {
  const lead = currentLead();
  if (!lead) return;

  const cleanLabel = String(label || '').trim();
  const normalized = normalizeLeadType(cleanLabel);

  // Sold is consequential: never add it directly from Quick Info.
  if (normalized === 'Sold' && !leadHasTag(lead, 'Sold')) {
    beginSoldFlow();
    return;
  }
  const key = normalized.toLowerCase();
  const selected = selectedLeadTags(lead);
  const isSelected = selected.has(key);
  lead.tags = Array.isArray(lead.tags) ? lead.tags : [];

  const removeMatchingTag = () => {
    lead.tags = lead.tags.filter(tag => normalizeLeadType(tag).toLowerCase() !== key);
  };
  const addTagIfMissing = () => {
    if (!lead.tags.some(tag => normalizeLeadType(tag).toLowerCase() === key)) lead.tags.push(cleanLabel);
  };

  if (normalized === 'Spanish?') {
    lead.spanishPossible = !isSelected;
    if (isSelected) removeMatchingTag();
    else addTagIfMissing();
  } else if (LEAD_TYPE_TAGS.has(normalized)) {
    // Website condition is optional: zero OR one can be active.
    // Clicking a different site condition switches to it and removes the old one.
    // Clicking the currently selected condition untoggles it.
    const removingCurrentSiteTag = isSelected;

    lead.tags = lead.tags.filter(tag => !LEAD_TYPE_TAGS.has(normalizeLeadType(tag)));

    if (removingCurrentSiteTag) {
      lead.leadType = '';
    } else {
      lead.tags.push(normalized);
      lead.leadType = normalized;
    }

    // Removing No Site offers a chance to add the actual website.
    if (normalized === 'No Site' && removingCurrentSiteTag) {
      setTimeout(() => openAddSitePrompt(), 0);
    }
  } else {
    if (isSelected) {
      removeMatchingTag();
      if (normalizeLeadType(lead.tag).toLowerCase() === key) {
        lead.tag = lead.tags
          .map(tag => normalizeLeadType(tag))
          .find(tag => FOLLOWUP_TAGS.has(tag) && tag !== 'Hot Lead') || '';
      }
    } else {
      addTagIfMissing();

      // A selected status tag should also be the lead's primary SQL `tag`.
      // This is important for priority tags such as Hot Lead and Wrong Number:
      // Supabase stores the full tag list in `tags`, but the main status badge
      // and SQL `tag` column come from lead.tag.
      if (FOLLOWUP_TAGS.has(cleanLabel)) {
        // Hot Lead is a priority flag, not the legacy single-value status.
        // Persist it in `tags` so Supabase keeps it across refreshes.
        if (normalized !== 'Hot Lead') {
          lead.tag = cleanLabel;
        }
      }
    }
  }

  saveState(lead.id);
  renderQuickInfoTags();
  renderSourceTags();
  renderLeadHistory();
  renderLists();
  try {
    if (normalized === 'Hot Lead') {
      // Hot Lead is intentionally persisted DIRECTLY to the SQL `tags` array.
      // Do not depend on the legacy single-value `tag` column or a whole-row upsert.
      const savedTags = await syncLeadTagsOnly(lead);
      const remoteHasHot = savedTags.some(
        tag => String(tag || '').trim().toLowerCase() === 'hot lead'
      );

      if (!isSelected && !remoteHasHot) {
        throw new Error('Supabase did not save Hot Lead inside tags');
      }
      if (isSelected && remoteHasHot) {
        throw new Error('Supabase did not remove Hot Lead from tags');
      }

      renderQuickInfoTags();
      renderLists();
      showSyncStatus(isSelected ? 'Hot Lead removed' : 'Hot Lead saved');
    } else {
      await syncLeadNow(lead);
      showSyncStatus(
        LEAD_TYPE_TAGS.has(normalized)
          ? (isSelected ? `${normalized} removed` : `${normalized} selected`)
          : (isSelected ? 'Tag removed' : 'Tag added')
      );
    }
  } catch (error) {
    console.error('Could not update tag in Supabase:', error);
    queueLeadSync(lead.id);
    showSyncStatus('Sync failed');
  }
}

function leadHasTag(lead, label) {
  const key = String(label || '').trim().toLowerCase();
  return String(lead?.tag || '').trim().toLowerCase() === key ||
    (Array.isArray(lead?.tags) && lead.tags.some(tag => String(tag || '').trim().toLowerCase() === key));
}

function leadPriority(lead) {
  if (leadHasTag(lead, 'Hot Lead')) return 2;
  if (leadHasTag(lead, 'Wrong Number') || String(lead?.outcome || '').trim().toLowerCase() === 'wrong number') return 1;
  return 0;
}

function leadCard(lead) {
  const isNew = lead.status === 'new';
  const isSold = lead.status === 'sold';
  const leadType = getLeadType(lead);
  ensureAutomaticTags(lead);
  const isHot = leadHasTag(lead, 'Hot Lead');
  const isWrongNumber = leadHasTag(lead, 'Wrong Number') || String(lead.outcome || '').trim().toLowerCase() === 'wrong number';
  const hasNoPhone = Array.isArray(lead.tags) && lead.tags.some(tag => String(tag || '').trim().toLowerCase() === 'no phone');
  const badges = [
    leadType && leadType !== 'Spanish?' ? `<span class="lead-type-badge">${escapeHTML(leadType)}</span>` : '',
    hasNoPhone ? '<span class="lead-type-badge no-phone-badge">No Phone</span>' : '',
    hasPossibleSpanishTag(lead) || leadType === 'Spanish?' ? '<span class="lead-type-badge spanish-badge">Spanish?</span>' : '',
    !isNew && lead.tag && !isHot && !isWrongNumber ? `<span class="tag-badge${isSold ? ' sold-tag-badge' : ''}">${escapeHTML(lead.tag)}</span>` : ''
  ].filter(Boolean).join('');
  const initial = (lead.name || '?').trim().charAt(0).toUpperCase();
  const visibleSourceTags = (Array.isArray(lead.sourceTags) ? lead.sourceTags : [])
    .filter(tag => String(tag || '').trim().toLowerCase() !== 'other')
    .filter(tag => !REMOVED_SOURCE_TAGS.has(String(tag || '').trim().toLowerCase()))
    .filter(tag => String(tag || '').trim());
  const sourceBadges = visibleSourceTags.map(label => {
    const clean = String(label || '').trim();
    const meta = getSourceTagMeta(clean);
    return `<span class="lead-source-chip ${meta.className}"><i class="bi ${meta.icon}" aria-hidden="true"></i><span>${escapeHTML(clean)}</span></span>`;
  }).join('');
  const cornerTags = [
    isHot ? '<span class="priority-corner-tag hot-lead-tag">🔥 HOT LEAD</span>' : '',
    isWrongNumber ? '<span class="priority-corner-tag wrong-number-tag">WRONG NUMBER</span>' : ''
  ].filter(Boolean).join('');

  const manageLeadButton = currentUserIsKiara()
    ? `<button class="lead-card-edit" type="button" data-edit-lead-status="${lead.id}" aria-label="Edit lead status" title="Edit lead"><i class="bi bi-pencil-square"></i></button>`
    : '';

  return `
    <div class="lead-item-wrap">
      <button class="lead-item${isHot ? ' hot-lead-card' : ''}${isWrongNumber ? ' wrong-number-card' : ''}" type="button" data-open-lead="${lead.id}">
        ${cornerTags ? `<span class="lead-priority-tags">${cornerTags}</span>` : ''}
        <span class="lead-avatar">${escapeHTML(initial)}</span>
        <span class="lead-copy">
          <span class="lead-name-line"><strong>${escapeHTML(lead.company || 'No company')}</strong>${badges}${isHot ? '<span class="mobile-hot-lead-badge">🔥 HOT LEAD</span>' : ''}</span>
          <span class="lead-company">${escapeHTML(lead.name || 'No contact name')}</span>
          ${isSold
            ? `<span class="lead-called-by sold-by-card"><i class="bi bi-trophy-fill" aria-hidden="true"></i>Sold by ${escapeHTML(lead.soldBy || latestSoldActor(lead) || 'Unassigned')}</span>`
            : `<span class="lead-called-by ${latestCallHistory(lead) ? 'has-call' : 'no-call'}"><i class="bi bi-telephone-fill" aria-hidden="true"></i>${escapeHTML(callerSummary(lead, false))}</span>`}
          ${sourceBadges ? `<span class="lead-source-tags">${sourceBadges}</span>` : ''}
        </span>
        <i class="bi bi-chevron-right"></i>
      </button>
      ${manageLeadButton}
    </div>`;
}

function renderLists() {
  const query = ($('#leadSearch').value || '').trim().toLowerCase();
  const matches = lead => !query || [lead.name, lead.company, lead.phone, lead.email, lead.tag, getLeadType(lead), hasPossibleSpanishTag(lead) ? 'Spanish?' : '', ...(Array.isArray(lead.sourceTags) ? lead.sourceTags : [])].some(v => String(v || '').toLowerCase().includes(query));
  const sortPriority = (a, b, fallback) => {
    const priorityDiff = leadPriority(b) - leadPriority(a);
    return priorityDiff || fallback(a, b);
  };
  const fresh = state.leads
    .filter(l => l.status === 'new' && matches(l))
    .slice()
    .sort((a, b) => sortPriority(a, b, (x, y) => state.leads.indexOf(y) - state.leads.indexOf(x)));
  const follow = state.leads
    .filter(l => l.status === 'followup' && matches(l))
    .sort((a,b) => sortPriority(a, b, (x, y) => new Date(y.lastCalled || 0) - new Date(x.lastCalled || 0)));
  const sold = state.leads
    .filter(l => l.status === 'sold' && matches(l))
    .sort((a,b) => sortPriority(a, b, (x, y) => new Date(y.soldAt || y.updatedAt || y.lastCalled || 0) - new Date(x.soldAt || x.updatedAt || x.lastCalled || 0)));

  $('#newLeadList').innerHTML = fresh.length ? fresh.map(leadCard).join('') : '<div class="empty-state">No new leads here.</div>';
  $('#followLeadList').innerHTML = follow.length ? follow.map(leadCard).join('') : '<div class="empty-state">No follow-ups yet.</div>';
  $('#soldLeadList').innerHTML = sold.length ? sold.map(leadCard).join('') : '<div class="empty-state sold-empty-state">No sold leads yet.</div>';

  const newCount = state.leads.filter(l => l.status === 'new').length;
  const followCount = state.leads.filter(l => l.status === 'followup').length;
  const soldCount = state.leads.filter(l => l.status === 'sold').length;
  $('#newCount').textContent = newCount;
  $('#followCount').textContent = followCount;
  $('#soldCount').textContent = soldCount;
  $('#newCountChip').textContent = newCount;
  $('#followCountChip').textContent = followCount;
  $('#soldCountChip').textContent = soldCount;

  // Keep the selected pipeline category separated after every render.
  const selectedPipeline = document.querySelector('[data-pipeline-view].active')?.dataset.pipelineView || 'leads';
  const screen = document.getElementById('leadsScreen');
  if (screen) {
    screen.classList.remove('desktop-leads-view', 'desktop-followups-view', 'desktop-sold-view');
    screen.classList.add(
      selectedPipeline === 'followups'
        ? 'desktop-followups-view'
        : selectedPipeline === 'sold'
          ? 'desktop-sold-view'
          : 'desktop-leads-view'
    );
  }
}

function openLead(id) {
  currentLeadId = id;
  sourceTagsExpanded = false;
  historyExpanded = true;
  updateHistoryVisibility();
  renderCurrentLead();
  setTab('detailsPanel');
  showScreen('detail');
}

function renderCurrentLead() {
  const lead = currentLead();
  if (!lead) return;

  const editLeadButton = $('#editLeadButton');
  if (editLeadButton) editLeadButton.hidden = !currentUserIsKiara();

  const soldLead = lead.status === 'sold';
  const kiaraCanSeeSoldPhone = soldLead && currentUserIsKiara();
  const phoneIsHidden = soldLead && !kiaraCanSeeSoldPhone;
  $('#leadPhone').textContent = phoneIsHidden ? 'Hidden after sale' : (lead.phone ? formatPhoneNumber(lead.phone) : 'No phone');
  const phoneLabel = document.querySelector('.phone-card-label');
  if (phoneLabel) phoneLabel.textContent = phoneIsHidden ? 'PHONE NUMBER · KIARA ONLY' : 'PHONE NUMBER';
  const calledByEl = $('#leadCalledBy');
  if (calledByEl) {
    calledByEl.hidden = soldLead;
    calledByEl.textContent = callerSummary(lead, true);
    calledByEl.classList.toggle('has-call', Boolean(latestCallHistory(lead)));
  }
  const soldByEl = $('#soldByDetail');
  if (soldByEl) {
    soldByEl.hidden = !soldLead;
    soldByEl.textContent = soldLead ? `Sold by ${lead.soldBy || latestSoldActor(lead) || 'Unassigned'}` : '';
  }
  const callButton = $('#topCallButton');
  const mobileCallButton = $('#mobilePreCallButton');
  const canCall = Boolean(lead.phone) && (!soldLead || kiaraCanSeeSoldPhone);

  if (callButton) {
    callButton.hidden = !canCall;
    callButton.href = '#';
    callButton.dataset.tel = canCall ? `tel:${String(lead.phone || '').replace(/[^\d+]/g, '')}` : '';
    callButton.setAttribute('aria-disabled', canCall ? 'false' : 'true');
  }

  if (mobileCallButton) {
    mobileCallButton.hidden = !canCall;
    mobileCallButton.disabled = !canCall;
    mobileCallButton.setAttribute('aria-disabled', canCall ? 'false' : 'true');
  }
  $('#leadName').textContent = lead.name || 'No contact name';
  $('#leadCompany').textContent = lead.company || '—';
  $('#leadEmail').textContent = lead.email || 'No email';
  $('#leadEmail').href = lead.email ? `mailto:${lead.email}` : '#';
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
  renderQuickInfoTags();
  renderSourceTags();
  renderLeadHistory();

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
  const validTabs = new Set(['detailsPanel', 'followupPanel', 'quickPanel']);
  const safePanelId = validTabs.has(panelId) ? panelId : 'detailsPanel';
  $$('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === safePanelId));
  $$('.panel').forEach(panel => panel.classList.toggle('active', panel.id === safePanelId));
  savePageState({ tab: safePanelId });
}

function restorePageState() {
  const saved = loadPageState();
  const validTabs = new Set(['detailsPanel', 'followupPanel', 'quickPanel']);
  const savedTab = validTabs.has(saved.tab) ? saved.tab : 'detailsPanel';

  if (saved.screen === 'detail' && saved.leadId && state.leads.some(lead => lead.id === saved.leadId)) {
    currentLeadId = saved.leadId;
    sourceTagsExpanded = false;
    historyExpanded = true;
    updateHistoryVisibility();
    renderCurrentLead();
    setTab(savedTab);
    showScreen('detail');
    return true;
  }

  setTab(savedTab);
  clearDetailPageState();
  showScreen('leads');
  return false;
}

function autosaveField(element) {
  const lead = currentLead();
  if (!lead) return;
  lead[element.dataset.save] = element.value;
  saveState();
}

let quickNotesBeforeEdit = '';
let historyExpanded = true;
function noteAddedText(before, after) {
  const previous = String(before || '').trim();
  const current = String(after || '').trim();
  if (!current || current === previous) return '';
  if (previous && current.startsWith(previous)) return current.slice(previous.length).trim();
  return current;
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

async function deleteLeadPermanently(leadId) {
  if (!currentUserIsKiara()) return toast('Only Kiara can delete leads');

  const lead = state.leads.find(item => item.id === leadId);
  if (!lead) return;

  if (supabaseSession) {
    for (const table of ['new_leads', 'follow_ups', 'sold_leads']) {
      const { error } = await supabaseClient.from(table).delete().eq('id', leadId);
      if (error) throw error;
    }
    const { error: privatePhoneError } = await supabaseClient.from('sold_private_phones').delete().eq('lead_id', leadId);
    if (privatePhoneError) console.warn('Could not delete private sold phone:', privatePhoneError);
  }

  state.leads = state.leads.filter(item => item.id !== leadId);
  pendingSyncIds.delete(leadId);
  if (currentLeadId === leadId) currentLeadId = null;
  renderLists();
  showSyncStatus('Lead deleted');
  toast('Lead deleted');
}

function openLeadDeleteConfirmation(leadId) {
  if (!currentUserIsKiara()) return toast('Only Kiara can delete leads');

  const lead = state.leads.find(item => item.id === leadId);
  if (!lead) return;

  pendingLeadDeleteId = leadId;
  const label = lead.company || lead.name || 'this lead';
  $('#leadDeleteConfirmText').textContent = `Are you sure you want to permanently delete ${label}? This cannot be undone.`;
  openModal('leadDeleteConfirmModal');
}

$('#confirmLeadDeleteButton')?.addEventListener('click', async () => {
  const id = pendingLeadDeleteId;
  pendingLeadDeleteId = '';
  closeModal('leadDeleteConfirmModal');
  if (!id) return;

  try {
    await deleteLeadPermanently(id);
  } catch (error) {
    console.error('Could not delete lead from Supabase:', error);
    showSyncStatus('Delete failed');
    toast('Could not delete lead');
  }
});


$$('[data-lead-status-option]').forEach(button => {
  button.addEventListener('click', async () => {
    const id = editingLeadStatusId;
    if (!id) return;
    try {
      await setLeadPipelineStatus(id, button.dataset.leadStatusOption);
    } catch (error) {
      console.error('Could not update lead status:', error);
      showSyncStatus('Status update failed');
      toast('Could not update lead status');
    }
  });
});

$('#deleteLeadFromEditButton')?.addEventListener('click', () => {
  const id = editingLeadStatusId;
  if (!id) return;
  closeModal('leadStatusEditModal');
  openLeadDeleteConfirmation(id);
});

// Navigation / lists
$('#backButton').addEventListener('click', () => { renderLists(); clearDetailPageState(); showScreen('leads'); });
$('#leadSearch').addEventListener('input', renderLists);
$('#addLeadBottomButton').addEventListener('click', openNewLeadModal);
document.getElementById('desktopHeaderAddLeadButton')?.addEventListener('click', openNewLeadModal);
$('#editLeadButton')?.addEventListener('click', () => openEditLeadModal());
document.addEventListener('click', event => {
  const editLeadStatusButton = event.target.closest('[data-edit-lead-status]');
  if (editLeadStatusButton) {
    event.preventDefault();
    event.stopPropagation();
    openEditLeadModal(editLeadStatusButton.dataset.editLeadStatus);
    return;
  }

  const leadButton = event.target.closest('[data-open-lead]');
  if (!leadButton) return;

  event.preventDefault();
  event.stopPropagation();
  openLead(leadButton.dataset.openLead);
});

document.querySelectorAll('[data-close="newLeadModal"]').forEach(button => button.addEventListener('click', () => {
  editingLeadId = null;
  setLeadModalMode('add');
}));

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

// Call flow: show lead context first, launch phone call, then ask a few quick questions.
let postCallAnswer = '';
let postCallMood = '';
let postCallTag = '';
let pendingCallLeadId = '';
let callLaunchAt = 0;

function callPromptForLead(lead) {
  const type = getActiveSiteTag(lead);
  const rawFirstName = String(lead?.name || '').trim().split(/\s+/)[0] || '';
  const firstName = rawFirstName || '____';
  const callerName = activeUserName();

  const safeLeadName = escapeHTML(firstName);
  const safeCallerName = escapeHTML(callerName);

  if (type === 'No Site') {
    return {
      type: 'NO SITE',
      className: 'prompt-no-site',
      html: `Hey <mark>${safeLeadName}</mark>, my name is <mark>${safeCallerName}</mark>. I was looking into your business earlier and I <mark>couldn’t find</mark> a website. I actually work with <mark>Steady Hands Operations</mark> — we help businesses <mark>get set up</mark> with a <mark>professional site</mark>. I just wanted to see if that’s something <mark>you’re considering</mark>.`
    };
  }

  if (type === 'Broken Site') {
    return {
      type: 'BROKEN SITE',
      className: 'prompt-broken-site',
      html: `Hey <mark>${safeLeadName}</mark>, my name is <mark>${safeCallerName}</mark>. I was looking at your website earlier and I <mark>noticed</mark> a couple parts <mark>weren’t working properly</mark>. I actually work with <mark>Steady Hands Operations</mark> — we help businesses <mark>get set up</mark> with <mark>professional sites</mark>; or if you’re just looking for a <mark>quick fix</mark> I can look to <mark>get you a quote</mark>. Is that something you’d be <mark>interested in getting fixed</mark>?`
    };
  }

  if (type === 'Outdated Site') {
    return {
      type: 'OUTDATED SITE',
      className: 'prompt-outdated-site',
      html: `Hey <mark>${safeLeadName}</mark>, my name is <mark>${safeCallerName}</mark>. I was <mark>looking</mark> at your website earlier and <mark>noticed</mark> a couple things that seem pretty <mark>dated</mark>. I actually work with <mark>Steady Hands Operations</mark> — we help businesses <mark>redesign</mark> and <mark>upgrade</mark> older sites. I just wanted to see if that’s something you’d be <mark>open</mark> to talking about.`
    };
  }

  return {
    type: 'WEBSITE LEAD',
    className: 'prompt-generic-site',
    html: `Hey <mark>${safeLeadName}</mark>, my name is <mark>${safeCallerName}</mark>. I was <mark>looking into your business</mark> earlier and wanted to reach out about your website. I work with <mark>Steady Hands Operations</mark> — we help businesses <mark>improve</mark>, <mark>build</mark>, and <mark>maintain</mark> professional websites. I just wanted to see if that’s something you’d be <mark>open</mark> to talking about.`
  };
}

function openPreCallModal() {
  const lead = currentLead();
  if (!lead || !lead.phone || (lead.status === 'sold' && !currentUserIsKiara())) return;

  $('#preCallLeadName').textContent = `${lead.company || 'No company'}${lead.name ? ` · ${lead.name}` : ''}`;
  $('#preCallNotes').textContent = String(lead.notes || '').trim() || 'No notes yet.';
  const sources = (Array.isArray(lead.sourceTags) ? lead.sourceTags : [])
    .filter(tag => String(tag || '').trim() && String(tag || '').trim().toLowerCase() !== 'other');
  $('#preCallSources').textContent = sources.length ? sources.join(' · ') : 'No source saved.';

  const prompt = callPromptForLead(lead);
  $('#callPromptType').textContent = prompt.type;
  $('#callPromptText').innerHTML = prompt.html;
  const promptBox = $('#callPromptBox');
  promptBox.classList.remove('prompt-no-site', 'prompt-broken-site', 'prompt-outdated-site', 'prompt-generic-site');
  promptBox.classList.add(prompt.className || 'prompt-generic-site');
  $('#callPromptBox').hidden = true;
  $('#callPromptToggle').setAttribute('aria-expanded', 'false');
  $('#callPromptToggle').innerHTML = '<i class="bi bi-chat-quote"></i><span>Show Call Prompt</span><i class="bi bi-chevron-down"></i>';

  openModal('preCallModal');
}

$('#topCallButton')?.addEventListener('click', event => {
  event.preventDefault();
  openPreCallModal();
});

$('#mobilePreCallButton')?.addEventListener('click', event => {
  event.preventDefault();
  openPreCallModal();
});

$('#callPromptToggle')?.addEventListener('click', () => {
  const box = $('#callPromptBox');
  if (!box) return;
  const opening = box.hidden;
  box.hidden = !opening;
  $('#callPromptToggle').setAttribute('aria-expanded', opening ? 'true' : 'false');
  $('#callPromptToggle').innerHTML = opening
    ? '<i class="bi bi-chat-quote"></i><span>Hide Call Prompt</span><i class="bi bi-chevron-up"></i>'
    : '<i class="bi bi-chat-quote"></i><span>Show Call Prompt</span><i class="bi bi-chevron-down"></i>';
});

function resetPostCallForm(lead) {
  postCallAnswer = '';
  postCallMood = '';
  postCallTag = '';
  $$('[data-post-answer], [data-post-mood], [data-post-tag]').forEach(button => button.classList.remove('selected'));
  const missingAnswer = !String(lead?.answerStatus || '').trim();
  const missingMood = !String(lead?.mood || '').trim();
  const missingStatus = !String(lead?.tag || '').trim();

  $('#postAnswerQuestion').hidden = !missingAnswer;
  $('#postMoodQuestion').hidden = !missingMood;
  $('#postStatusQuestion').hidden = !missingStatus;

  return { missingAnswer, missingMood, missingStatus };
}

function openPostCallCheckIn() {
  const lead = currentLead();
  if (!lead) return false;
  const missing = resetPostCallForm(lead);
  const hasMissing = Object.values(missing).some(Boolean);
  if (!hasMissing) return false;
  openModal('postCallModal');
  return true;
}

$('#startActualCallButton')?.addEventListener('click', () => {
  const lead = currentLead();
  if (!lead || !lead.phone || (lead.status === 'sold' && !currentUserIsKiara())) return;

  const tel = `tel:${String(lead.phone || '').replace(/[^\d+]/g, '')}`;
  lead.lastCalled = new Date().toISOString();
  addLeadHistory(lead, 'called', currentUserName, lead.lastCalled);
  saveState(lead.id);
  renderCurrentLead();
  renderLists();

  closeModal('preCallModal');
  window.location.href = tel;
});


$$('[data-post-answer]').forEach(button => {
  button.addEventListener('click', () => {
    postCallAnswer = button.dataset.postAnswer || '';
    $$('[data-post-answer]').forEach(btn => btn.classList.toggle('selected', btn === button));
  });
});
$$('[data-post-mood]').forEach(button => {
  button.addEventListener('click', () => {
    postCallMood = button.dataset.postMood || '';
    $$('[data-post-mood]').forEach(btn => btn.classList.toggle('selected', btn === button));
  });
});
$$('[data-post-tag]').forEach(button => {
  button.addEventListener('click', () => {
    const value = button.dataset.postTag || '';
    postCallTag = postCallTag === value ? '' : value;
    $$('[data-post-tag]').forEach(btn => btn.classList.toggle('selected', btn.dataset.postTag === postCallTag));
  });
});

async function saveVisiblePostCallAnswers() {
  const lead = currentLead();
  if (!lead) return;

  if (!$('#postAnswerQuestion').hidden && postCallAnswer) lead.answerStatus = postCallAnswer;
  if (!$('#postMoodQuestion').hidden && postCallMood) lead.mood = postCallMood;

  if (!$('#postStatusQuestion').hidden && postCallTag) {
    if (postCallTag === 'Sold') {
      closeModal('postCallModal');
      beginSoldFlow();
      return 'sold-flow';
    }

    lead.tags = Array.isArray(lead.tags) ? lead.tags : [];
    const key = postCallTag.toLowerCase();
    lead.tags = lead.tags.filter(tag => String(tag || '').trim().toLowerCase() !== key);
    lead.tags.push(postCallTag);
    lead.tag = postCallTag;

    if (postCallTag === 'Wrong Number') lead.outcome = 'Wrong Number';
    if (postCallTag === 'No Answer') lead.outcome = 'No Answer';
    if (postCallTag === 'Interested' || postCallTag === 'Hot Lead') lead.outcome = 'Interested';
  }


  saveState(lead.id);
  renderCurrentLead();
  renderLists();

  try {
    await syncLeadNow(lead);
    showSyncStatus('Call details synced');
  } catch (error) {
    console.error('Could not sync call details:', error);
    queueLeadSync(lead.id);
    showSyncStatus('Sync failed');
  }

  return 'saved';
}

$('#skipPostCallButton')?.addEventListener('click', async () => {
  closeModal('postCallModal');
  const lead = currentLead();
  await finishLeadAndExit(lead?.tag || '');
});

$('#savePostCallButton')?.addEventListener('click', async () => {
  const result = await saveVisiblePostCallAnswers();
  if (result === 'sold-flow') return;
  closeModal('postCallModal');
  const lead = currentLead();
  await finishLeadAndExit(lead?.tag || '');
});


$('#outcomeField')?.addEventListener('change', async () => {
  const lead = currentLead();
  if (!lead) return;
  if ($('#outcomeField').value === 'Wrong Number') {
    lead.tags = Array.isArray(lead.tags) ? lead.tags : [];
    if (!leadHasTag(lead, 'Wrong Number')) lead.tags.push('Wrong Number');
    lead.tag = 'Wrong Number';
    saveState(lead.id);
    renderLists();
    try { await syncLeadNow(lead); } catch (error) { console.error('Could not sync Wrong Number tag:', error); }
  }
});

// History is expanded by default; the user can still collapse it with the History button.
$('#historyToggleButton')?.addEventListener('click', () => {
  historyExpanded = !historyExpanded;
  renderLeadHistory();
});

let pendingHistoryDeleteId = '';
let pendingLeadDeleteId = '';

// Only Kiara gets X buttons for removable note and call history entries.
$('#leadHistoryList')?.addEventListener('click', event => {
  const button = event.target.closest('[data-delete-history]');
  if (!button || !currentUserIsKiara()) return;

  const lead = currentLead();
  const id = button.dataset.deleteHistory || '';
  const item = (lead?.history || []).find(entry => entry.id === id);
  if (!item) return;

  pendingHistoryDeleteId = id;
  $('#historyDeleteConfirmTitle').textContent = item.type === 'called' ? 'Delete call history?' : 'Delete note history?';
  $('#historyDeleteConfirmText').textContent = item.type === 'called'
    ? 'Are you sure you want to delete this call from History? If it is the only call on a Follow-up lead, the lead will move back to New Leads.'
    : 'Are you sure you want to delete this note from History?';
  openModal('historyDeleteConfirmModal');
});

$('#confirmHistoryDeleteButton')?.addEventListener('click', async () => {
  const id = pendingHistoryDeleteId;
  pendingHistoryDeleteId = '';
  closeModal('historyDeleteConfirmModal');
  if (id) await deleteHistoryEntry(id);
});


function openAddSitePrompt() {
  const lead = currentLead();
  if (!lead) return;
  const input = $('#addSitePromptInput');
  if (input) input.value = String(lead.site || '').trim();
  openModal('addSitePromptModal');
  setTimeout(() => input?.focus(), 50);
}

async function saveSiteFromPrompt() {
  const lead = currentLead();
  if (!lead) return;

  const input = $('#addSitePromptInput');
  const site = String(input?.value || '').trim();

  lead.site = site;
  saveState(lead.id);
  renderCurrentLead();
  renderLists();
  closeModal('addSitePromptModal');

  try {
    await syncLeadNow(lead);
    showSyncStatus(site ? 'Site saved' : 'Site left blank');
    toast(site ? 'Website saved' : 'Website left blank');
  } catch (error) {
    console.error('Could not save website:', error);
    queueLeadSync(lead.id);
    showSyncStatus('Sync failed');
    toast('Saved locally — sync pending');
  }
}

$('#saveAddedSiteButton')?.addEventListener('click', saveSiteFromPrompt);

$('#addSitePromptInput')?.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    saveSiteFromPrompt();
  }
});

$('#addSiteNotNowButton')?.addEventListener('click', () => {
  closeModal('addSitePromptModal');
});

// Lead tags: every available tag is visible and can be toggled on/off.
$('#quickTagsList')?.addEventListener('click', event => {
  const chip = event.target.closest('[data-toggle-lead-tag]');
  if (!chip) return;
  toggleQuickInfoTag(chip.dataset.toggleLeadTag || '');
});

$('#sourceTagsExpandButton')?.addEventListener('click', () => {
  sourceTagsExpanded = !sourceTagsExpanded;
  renderSourceTags();
});

$('#sourceTagsList')?.addEventListener('click', event => {
  const chip = event.target.closest('[data-toggle-source-tag]');
  if (!chip) return;
  const label = chip.dataset.toggleSourceTag || '';
  if (String(label).trim().toLowerCase() === 'other') {
    $('#customSourceInput').value = '';
    openModal('customSourceModal');
    setTimeout(() => $('#customSourceInput')?.focus(), 50);
    return;
  }
  toggleSourceTag(label);
});

async function saveCustomSource() {
  const lead = currentLead();
  const input = $('#customSourceInput');
  if (!lead || !input) return;
  const custom = String(input.value || '').trim().replace(/\s+/g, ' ');
  if (!custom) return toast('Type a source first');

  lead.sourceTags = Array.isArray(lead.sourceTags) ? lead.sourceTags : [];
  // "Other" is only an entry action now, not a stored source.
  lead.sourceTags = lead.sourceTags.filter(tag => String(tag || '').trim().toLowerCase() !== 'other');
  const exists = lead.sourceTags.some(tag => String(tag || '').trim().toLowerCase() === custom.toLowerCase());
  if (!exists) lead.sourceTags.push(custom);

  saveState(lead.id);
  closeModal('customSourceModal');
  sourceTagsExpanded = true;
  renderSourceTags();
  try {
    await syncLeadNow(lead);
    showSyncStatus(exists ? 'Source already added' : 'Source added');
  } catch (error) {
    console.error('Could not sync custom source:', error);
    showSyncStatus('Sync failed');
  }
}

$('#saveCustomSourceButton')?.addEventListener('click', saveCustomSource);
$('#customSourceInput')?.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    saveCustomSource();
  }
});

// Quick Notes is the single notes editor for every lead.
// It always opens with every saved note so notes are never split between screens.
$('#quickNotesButton')?.addEventListener('click', () => {
  const lead = currentLead();
  if (!lead) return;
  quickNotesBeforeEdit = String(lead.notes || '');
  $('#quickNotesInput').value = quickNotesBeforeEdit;
  openModal('quickNotesModal');
  setTimeout(() => $('#quickNotesInput')?.focus(), 50);
});

$('#saveQuickNote')?.addEventListener('click', async () => {
  const lead = currentLead();
  if (!lead) return;

  const updatedNotes = $('#quickNotesInput').value.trim();
  const addedText = noteAddedText(quickNotesBeforeEdit, updatedNotes);
  lead.notes = updatedNotes;

  if (addedText) {
    addLeadHistory(lead, 'note', currentUserName, new Date().toISOString(), { note: addedText });
  }

  quickNotesBeforeEdit = updatedNotes;
  saveState(lead.id);
  renderLeadHistory();
  renderLists();
  closeModal('quickNotesModal');

  try {
    await syncLeadNow(lead);
    showSyncStatus('Notes synced');
    toast(updatedNotes ? 'Notes saved' : 'Notes cleared');
  } catch (error) {
    console.error('Could not sync notes:', error);
    queueLeadSync(lead.id);
    showSyncStatus('Sync failed');
    toast('Notes saved locally — sync pending');
  }
});

// Done -> choose label -> move to follow-ups
// A prospect can only enter Follow-ups after an actual call has been logged.
function leadHasBeenCalled(lead) {
  if (!lead) return false;
  if (lead.lastCalled) return true;
  return Array.isArray(lead.history) && lead.history.some(item => item?.type === 'called');
}

$('#doneButton').addEventListener('click', async () => {
  const lead = currentLead();
  if (!leadHasBeenCalled(lead)) {
    toast('Call this prospect before moving to Follow-ups');
    return;
  }

  // Only ask the mini questions that are still empty.
  if (openPostCallCheckIn()) return;

  // Nothing is missing, so finish immediately with the lead's existing status tag.
  await finishLeadAndExit(lead?.tag || '');
});
$$('.tag-choice[data-tag]').forEach(button => {
  button.addEventListener('click', () => {
    const value = button.dataset.tag;
    if (value === 'Sold') {
      beginSoldFlow();
      return;
    }
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
async function completeLeadMove(tag = '') {
  const lead = currentLead();
  if (!lead) return;

  if (!leadHasBeenCalled(lead)) {
    closeModal('doneModal');
    toast('Call this prospect before moving to Follow-ups');
    return;
  }

  if (tag) {
    lead.tag = tag;
    lead.tags = Array.isArray(lead.tags) ? lead.tags : [];
    if (!lead.tags.some(existing => String(existing || '').trim().toLowerCase() === String(tag).trim().toLowerCase())) {
      lead.tags.push(tag);
    }
  }

  lead.spanishPossible = selectedSpanishPossible;
  lead.status = 'followup';
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

let soldFlowSelectedProducts = new Set();

function beginSoldFlow() {
  const lead = currentLead();
  if (!lead) return;

  const seller = activeUserName();
  $('#soldConfirmSummary').textContent =
    `${lead.company || 'No company'}${lead.name ? ` · ${lead.name}` : ''} will be marked Sold by ${seller}.`;

  closeModal('doneModal');
  closeModal('postCallModal');
  openModal('soldConfirmModal');
}

function soldEmailBody(lead, products, seller) {
  const sources = (Array.isArray(lead.sourceTags) ? lead.sourceTags : [])
    .filter(tag => String(tag || '').trim() && String(tag || '').trim().toLowerCase() !== 'other')
    .join(', ') || 'Not provided';

  const selected = products.length ? products.map(item => `- ${item}`).join('\n') : '- Not specified';

  return [
    'This person wants to purchase:',
    '',
    selected,
    '',
    'CLIENT INFORMATION',
    `Name: ${lead.name || 'Not provided'}`,
    `Company: ${lead.company || 'Not provided'}`,
    `Phone: ${lead.phone || 'Not provided'}`,
    `Email: ${lead.email || 'Not provided'}`,
    `Website: ${lead.site || 'Not provided'}`,
    `Found On: ${sources}`,
    `Lead Type: ${getLeadType(lead) || 'Not provided'}`,
    `Main Issue: ${lead.issue || 'Not provided'}`,
    `Concerns: ${lead.concerns || 'Not provided'}`,
    `Answer Status: ${lead.answerStatus || 'Not provided'}`,
    `Mood: ${lead.mood || 'Not provided'}`,
    `Call Outcome: ${lead.outcome || 'Not provided'}`,
    `Status Tag: Sold`,
    '',
    'NOTES',
    lead.notes || 'No notes.',
    '',
    `Sold by: ${seller}`
  ].join('\n');
}

function finalizeSoldAndDraftEmail() {
  const lead = currentLead();
  if (!lead) return;

  const products = [...soldFlowSelectedProducts];
  if (!products.length) {
    toast('Select at least one product');
    return;
  }

  const seller = activeUserName();
  const phoneForDraft = lead.phone || '';

  lead.tag = 'Sold';
  lead.tags = Array.isArray(lead.tags) ? lead.tags : [];
  if (!lead.tags.some(tag => String(tag || '').trim().toLowerCase() === 'sold')) lead.tags.push('Sold');
  lead.status = 'sold';
  lead.soldBy = seller;
  lead.soldAt = new Date().toISOString();
  addLeadHistory(lead, 'sold', seller, lead.soldAt, { soldBy: seller, products });

  const bodyLead = { ...lead, phone: phoneForDraft };
  const subject = `New Sale — ${lead.company || lead.name || 'Client'}`;
  const body = soldEmailBody(bodyLead, products, seller);
  const mailto = `mailto:kiara@steadyhands.op?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  saveState(lead.id);
  closeModal('soldProductsModal');
  renderLists();
  showScreen('leads');
  toast(`Sold · Sold by ${seller}`);

  // Start the sync, but do not block the email draft behind an async wait.
  syncLeadNow(lead).then(() => {
    if (!currentUserIsKiara()) {
      lead.phone = '';
      renderLists();
    }
    showSyncStatus('Sold lead synced');
  }).catch(error => {
    console.error('Could not sync sold lead:', error);
    queueLeadSync(lead.id);
    showSyncStatus('Sync failed');
  });

  window.location.href = mailto;
}

async function finishLeadAndExit(tag = '') {
  if (tag === 'Sold') {
    beginSoldFlow();
    return;
  }
  await completeLeadMove(tag);
}


$('#confirmSoldButton')?.addEventListener('click', () => {
  closeModal('soldConfirmModal');
  soldFlowSelectedProducts = new Set();
  $$('.sold-product-choice').forEach(button => button.classList.remove('selected'));
  $('#createSoldEmailButton').disabled = true;
  openModal('soldProductsModal');
});

$$('.sold-product-choice').forEach(button => {
  button.addEventListener('click', () => {
    const product = button.dataset.soldProduct || '';
    if (soldFlowSelectedProducts.has(product)) soldFlowSelectedProducts.delete(product);
    else soldFlowSelectedProducts.add(product);

    button.classList.toggle('selected', soldFlowSelectedProducts.has(product));
    $('#createSoldEmailButton').disabled = soldFlowSelectedProducts.size === 0;
  });
});

$('#createSoldEmailButton')?.addEventListener('click', finalizeSoldAndDraftEmail);

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

function resetLeadForm() {
  ['newName','newCompany','newPhone','newEmail','newSite','newAge','newIssue'].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });
}

function setLeadModalMode(mode) {
  const editing = mode === 'edit';
  const title = $('#newLeadTitle');
  const kicker = $('#newLeadKicker');
  const submit = $('#createLeadButton');
  if (title) title.textContent = editing ? 'Edit Lead' : 'Add Leads';
  if (kicker) kicker.textContent = editing ? 'UPDATE LEAD' : 'ADD TO INBOX';
  if (submit) submit.innerHTML = editing ? '<i class="bi bi-check2"></i> Save Changes' : 'Add Lead';
  $('#singleLeadTab').hidden = editing;
  $('#bulkLeadTab').hidden = editing;
  const importTabs = document.querySelector('.import-tabs');
  if (importTabs) importTabs.hidden = editing;
  if (editing) setLeadEntryMode('single');
}

function openNewLeadModal() {
  editingLeadId = null;
  resetLeadForm();
  setLeadModalMode('add');
  $('#bulkLeadJson').value = '';
  $('#bulkLeadFile').value = '';
  $('#importStatus').textContent = '';
  $('#importStatus').className = 'import-status';
  setLeadEntryMode('single');
  openModal('newLeadModal');
  setTimeout(() => $('#newCompany').focus(), 50);
}

function openEditLeadModal(leadId = currentLeadId) {
  if (!currentUserIsKiara()) return toast('Only Kiara can edit lead status');
  const lead = state.leads.find(item => item.id === leadId);
  if (!lead) return toast('Lead not found');

  editingLeadStatusId = lead.id;
  const label = lead.company || lead.name || 'Lead';
  $('#leadStatusEditName').textContent = label;
  $$('[data-lead-status-option]').forEach(button => {
    button.classList.toggle('selected', button.dataset.leadStatusOption === lead.status);
  });
  openModal('leadStatusEditModal');
}

async function setLeadPipelineStatus(leadId, nextStatus) {
  if (!currentUserIsKiara()) return toast('Only Kiara can edit lead status');
  if (!['new', 'followup', 'sold'].includes(nextStatus)) return;
  const lead = state.leads.find(item => item.id === leadId);
  if (!lead) return toast('Lead not found');
  const previousStatus = lead.status || 'new';
  if (previousStatus === nextStatus) {
    closeModal('leadStatusEditModal');
    return;
  }

  lead.status = nextStatus;
  lead.updatedAt = new Date().toISOString();
  if (nextStatus === 'sold') {
    lead.soldBy = currentUserName || 'Kiara';
    lead.soldAt = new Date().toISOString();
    addLeadHistory(lead, 'sold', lead.soldBy, lead.soldAt);
  } else if (previousStatus === 'sold') {
    lead.soldBy = '';
    lead.soldAt = '';
  }

  saveState(lead.id);
  renderLists();
  if (currentLeadId === lead.id) renderCurrentLead();

  await syncLeadNow(lead);
  if (previousStatus === 'sold' && nextStatus !== 'sold') {
    try { await supabaseClient.from('sold_private_phones').delete().eq('lead_id', lead.id); } catch (error) { console.warn('Could not clean sold private phone:', error); }
  }
  closeModal('leadStatusEditModal');
  const labels = { new: 'New Lead', followup: 'Follow-up', sold: 'Sold' };
  showSyncStatus(`Moved to ${labels[nextStatus]}`);
  toast(`Moved to ${labels[nextStatus]}`);
}


function makeLead(raw = {}) {
  const text = value => value == null ? '' : String(value).trim();
  return ensureAutomaticTags({
    id: crypto.randomUUID(),
    name: text(raw.name),
    company: text(raw.company ?? raw.companyName),
    phone: formatPhoneNumber(raw.phone ?? raw.phoneNumber),
    email: text(raw.email ?? raw.emailAddress),
    site: text(raw.site ?? raw.website ?? raw.url),
    age: text(raw.age ?? raw.siteAge),
    issue: text(raw.issue ?? raw.mainIssue),
    leadType: normalizeLeadType(raw.leadType ?? raw.type ?? raw.reason ?? (Array.isArray(raw.tags) ? raw.tags.find(tag => normalizeLeadType(tag) !== 'Spanish?') : '') ?? raw.issue ?? raw.mainIssue),
    tags: Array.isArray(raw.tags) ? raw.tags.map(text).filter(Boolean) : [],
    sourceTags: Array.isArray(raw.sourceTags ?? raw.source_tags ?? raw.foundOn ?? raw.found_on) ? (raw.sourceTags ?? raw.source_tags ?? raw.foundOn ?? raw.found_on).map(text).filter(Boolean).filter(tag => tag.toLowerCase() !== 'other') : [],
    status: 'new',
    lastCalled: '',
    history: Array.isArray(raw.history) ? raw.history : [],
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
  });
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

  const rawEmail = normalizeLeadText(raw.email ?? raw.emailAddress);
  if (rawEmail && state.leads.some(lead => normalizeLeadText(lead.email) === rawEmail)) return true;

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
    if (!lead.history.length) {
      addInitialSystemNoteHistory(lead);
      addLeadHistory(lead, 'added');
    }
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
  newPhoneInput.value = formatPhoneNumber(newPhoneInput.value);
});
newPhoneInput.addEventListener('paste', event => {
  event.preventDefault();
  const pasted = event.clipboardData?.getData('text') || '';
  newPhoneInput.value = formatPhoneNumber(pasted);
  newPhoneInput.dispatchEvent(new Event('input', { bubbles: true }));
});
newPhoneInput.addEventListener('keydown', event => {
  const allowed = ['Backspace','Delete','ArrowLeft','ArrowRight','Tab','Home','End'];
  if (allowed.includes(event.key) || event.metaKey || event.ctrlKey) return;
  if (!/^\d$/.test(event.key)) event.preventDefault();
});

// Pasted values are trimmed before insertion so copied text never starts/ends with stray spaces.
['newName','newCompany','newSite','newAge','newIssue'].forEach(id => {
  const input = $(`#${id}`);
  if (!input) return;
  input.addEventListener('paste', event => {
    event.preventDefault();
    const pasted = (event.clipboardData?.getData('text') || '').trim();
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    input.value = `${before}${pasted}${after}`.replace(/^\s+/, '');
    const caret = before.length + pasted.length;
    requestAnimationFrame(() => input.setSelectionRange?.(caret, caret));
  });
  input.addEventListener('blur', () => {
    input.value = input.value.trim();
  });
});

$('#singleLeadTab').addEventListener('click', () => setLeadEntryMode('single'));
$('#bulkLeadTab').addEventListener('click', () => setLeadEntryMode('bulk'));

$('#createLeadButton').addEventListener('click', async () => {
  const values = {
    name: $('#newName').value.trim(),
    company: $('#newCompany').value.trim(),
    phone: formatPhoneNumber($('#newPhone').value),
    email: $('#newEmail').value.trim(),
    site: $('#newSite').value.trim(),
    age: $('#newAge').value.trim(),
    issue: $('#newIssue').value.trim()
  };

  if (editingLeadId) {
    const lead = state.leads.find(item => item.id === editingLeadId);
    if (!lead) return toast('Lead not found');
    lead.name = values.name;
    lead.company = values.company;
    lead.phone = values.phone;
    lead.email = values.email;
    lead.site = values.site;
    ensureAutomaticTags(lead);
    lead.age = values.age;
    lead.issue = values.issue;
    saveState(lead.id);
    closeModal('newLeadModal');
    editingLeadId = null;
    setLeadModalMode('add');
    renderCurrentLead();
    renderLists();
    try {
      await syncLeadNow(lead);
      showSyncStatus('Lead updated');
    } catch (error) {
      console.error('Could not update lead:', error);
      showSyncStatus('Sync failed');
    }
    return toast('Lead updated');
  }

  const lead = makeLead(values);
  addLeadHistory(lead, 'added');
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
restorePageState();

async function submitLogin() {
  const email = $('#authEmail').value.trim();
  const password = $('#authPassword').value;
  const status = $('#authStatus');

  status.textContent = '';

  if (!email) {
    status.textContent = 'Enter your email.';
    $('#authEmail').focus();
    return;
  }

  if (!password) {
    status.textContent = 'Enter your password.';
    $('#authPassword').focus();
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
  updateSignedInUserUi();
  setAuthenticatedUi(true);

  try {
    await hydrateFromSupabase();
    await loadLeadsJson();
  } catch (syncError) {
    console.error(syncError);
    showSyncStatus('Sync failed');
  }
}

$('#authForm')?.addEventListener('submit', event => {
  event.preventDefault();
  submitLogin();
});

// Return/Enter in Email moves to Password instead of submitting immediately.
$('#authEmail')?.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  $('#authPassword')?.focus();
});

// Return/Enter in Password submits the login form.
$('#authPassword')?.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  $('#authForm')?.requestSubmit();
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
  if (session) updateSignedInUserUi();
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

// Desktop dashboard navigation. Reuses the same underlying actions as mobile.

// Escape key navigation: close the most recently opened UI first.
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;

  // 1) Close an open modal (Quick Notes, Add/Edit Lead, Account, Done, etc.).
  const openModals = [...document.querySelectorAll('.modal-backdrop.open')];
  if (openModals.length) {
    event.preventDefault();
    event.stopPropagation();
    closeModal(openModals[openModals.length - 1].id);
    return;
  }

  // 2) Close any open time picker/dropdown before navigating away.
  let closedPicker = false;
  ['callback', 'preferred'].forEach(prefix => {
    const ids = scheduleIds(prefix);
    if (ids?.timePicker && !ids.timePicker.hidden) {
      closeTimePicker(prefix);
      closedPicker = true;
    }
  });

  const specificPicker = document.getElementById('specificTimePicker');
  if (specificPicker && !specificPicker.hidden) {
    specificPicker.hidden = true;
    document.getElementById('specificTimeButton')?.setAttribute('aria-expanded', 'false');
    closedPicker = true;
  }

  if (closedPicker) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  // 3) If a lead is open, Escape behaves exactly like the Back button.
  const detailScreen = document.getElementById('detailScreen');
  if (detailScreen?.classList.contains('active')) {
    event.preventDefault();
    event.stopPropagation();
    document.getElementById('backButton')?.click();
  }
});

(() => {
  const leadsNav = document.getElementById('desktopLeadsNav');
  const followNav = document.getElementById('desktopFollowupsNav');
  const soldNav = document.getElementById('desktopSoldNav');
  const addNav = document.getElementById('desktopAddLeadNav');
  const accountNav = document.getElementById('desktopAccountNav');
  const leadsScreen = document.getElementById('leadsScreen');
  const pipelineButtons = [...document.querySelectorAll('[data-pipeline-view]')];

  let currentPipelineView = 'leads';

  const normalizePipeline = (value) =>
    ['leads', 'followups', 'sold'].includes(value) ? value : 'leads';

  const setDesktopActive = (which) => {
    [leadsNav, followNav, soldNav, addNav, accountNav].forEach(btn => {
      btn?.classList.remove('active');
    });
    which?.classList.add('active');
  };

  const navForPipeline = (view) => {
    if (view === 'followups') return followNav;
    if (view === 'sold') return soldNav;
    return leadsNav;
  };

  const applyPipelineView = (requestedView, options = {}) => {
    if (!leadsScreen) return;

    const view = normalizePipeline(requestedView);
    const { persist = true, scroll = false } = options;

    leadsScreen.classList.remove(
      'desktop-leads-view',
      'desktop-followups-view',
      'desktop-sold-view'
    );

    leadsScreen.classList.add(
      view === 'followups'
        ? 'desktop-followups-view'
        : view === 'sold'
          ? 'desktop-sold-view'
          : 'desktop-leads-view'
    );

    pipelineButtons.forEach(button => {
      const active = button.dataset.pipelineView === view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    setDesktopActive(navForPipeline(view));

    currentPipelineView = view;

    if (scroll) {
      const target =
        view === 'followups'
          ? document.querySelector('#leadsScreen .follow-heading')
          : view === 'sold'
            ? document.querySelector('#leadsScreen .sold-heading')
            : document.querySelector(
                '#leadsScreen .section-heading:not(.follow-heading):not(.sold-heading)'
              );

      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // Top New Leads / Follow-ups / Sold Leads tabs.
  // These are the pipeline navigation on BOTH desktop and mobile.
  const activatePipelineButton = button => {
    if (!button?.dataset?.pipelineView) return;
    showScreen('leads');
    applyPipelineView(button.dataset.pipelineView, { persist: true, scroll: false });

    // Mobile should always land at the top of the selected category.
    if (window.matchMedia('(max-width: 959px)').matches) {
      document.getElementById('leadsScreen')?.scrollIntoView({ block: 'start' });
    }
  };

  pipelineButtons.forEach(button => {
    button.setAttribute('role', 'tab');
    button.addEventListener('click', event => {
      event.preventDefault();
      activatePipelineButton(button);
    });
  });

  // Desktop sidebar buttons use the exact same pipeline state.
  leadsNav?.addEventListener('click', () => {
    showScreen('leads');
    applyPipelineView('leads', { persist: true, scroll: false });
  });

  followNav?.addEventListener('click', () => {
    showScreen('leads');
    applyPipelineView('followups', { persist: true, scroll: false });
  });

  soldNav?.addEventListener('click', () => {
    showScreen('leads');
    applyPipelineView('sold', { persist: true, scroll: false });
  });

  addNav?.addEventListener('click', () => {
    setDesktopActive(addNav);
    document.getElementById('addLeadBottomButton')?.click();
  });

  accountNav?.addEventListener('click', () => {
    setDesktopActive(accountNav);
    document.getElementById('accountButton')?.click();
  });

  document.getElementById('backButton')?.addEventListener('click', () => {
    applyPipelineView(currentPipelineView, { persist: false, scroll: false });
  });

  // Always start on New Leads after a full reload.
  applyPipelineView('leads', { persist: false, scroll: false });
})();
