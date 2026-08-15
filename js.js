const STORAGE_KEY = 'steadyHandsLeadApp_v4';

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

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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

function leadCard(lead) {
  const isNew = lead.status === 'new';
  const meta = isNew ? '' : `Last called: ${formatDateTime(lead.lastCalled)}`;
  const badge = isNew
    ? '<span class="new-badge">NEW</span>'
    : `${lead.tag ? `<span class="tag-badge">${escapeHTML(lead.tag)}</span>` : ''}${lead.spanishPossible ? `<span class="tag-badge spanish-badge">Spanish?</span>` : ''}`;
  const initial = (lead.name || '?').trim().charAt(0).toUpperCase();

  return `
    <button class="lead-item" type="button" data-open-lead="${lead.id}">
      <span class="lead-avatar">${escapeHTML(initial)}</span>
      <span class="lead-copy">
        <span class="lead-name-line"><strong>${escapeHTML(lead.name)}</strong>${badge}</span>
        <span class="lead-company">${escapeHTML(lead.company || 'No company')}</span>
        ${meta ? `<span class="lead-meta">${escapeHTML(meta)}</span>` : ''}
      </span>
      <i class="bi bi-chevron-right"></i>
    </button>`;
}

function renderLists() {
  const query = ($('#leadSearch').value || '').trim().toLowerCase();
  const matches = lead => !query || [lead.name, lead.company, lead.phone, lead.tag].some(v => String(v || '').toLowerCase().includes(query));
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

// Single-select controls: nothing is visually selected until clicked unless a saved value already exists.
$$('[data-field]').forEach(button => {
  button.addEventListener('click', () => {
    const lead = currentLead();
    if (!lead) return;
    const field = button.dataset.field;
    const value = button.dataset.value;
    lead[field] = value;
    $$(`[data-field="${field}"]`).forEach(item => item.classList.toggle('selected', item === button));
    if (field === 'timePreference') {
      const specific = value === 'Specific Time';
      const control = $('#specificTimeControl');
      if (control) control.hidden = !specific;
      if (!specific) {
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
    selectedDoneTag = button.dataset.tag;
    $$('.tag-choice[data-tag]').forEach(btn => btn.classList.toggle('selected', btn === button));
    $('#finishLeadButton').disabled = false;
  });
});

const spanishTagChoice = $('#spanishTagChoice');
if (spanishTagChoice) {
  spanishTagChoice.addEventListener('click', () => {
    selectedSpanishPossible = !selectedSpanishPossible;
    spanishTagChoice.classList.toggle('selected', selectedSpanishPossible);
  });
}
$('#finishLeadButton').addEventListener('click', () => {
  const lead = currentLead();
  if (!lead || !selectedDoneTag) return;
  lead.tag = selectedDoneTag;
  lead.spanishPossible = selectedSpanishPossible;
  lead.status = 'followup';
  lead.lastCalled = new Date().toISOString();
  saveState();
  closeModal('doneModal');
  renderLists();
  showScreen('leads');
  toast(`Moved to Follow-ups · ${selectedDoneTag}`);
});

// Share / export every lead as JSON text.
// macOS assigns .json files the icon of the app associated with JSON (Firefox on some Macs).
// Using .txt avoids that app association while keeping the contents valid JSON.
async function shareAllLeads() {
  const exportData = {
    leads: state.leads.map(lead => {
      const { addedAt, AddedAt, addedat, ...cleanLead } = lead || {};
      return cleanLead;
    })
  };
  const json = JSON.stringify(exportData, null, 2);
  const file = new File([json], 'all-leads.txt', { type: 'text/plain;charset=utf-8' });

  try {
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      await navigator.share({
        title: 'All Leads',
        text: 'Lead export',
        files: [file]
      });
      return;
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
  }

  // Desktop/browser fallback: export the exact same JSON content as a plain-text file.
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'all-leads.txt';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Exported all leads');
}

$('#shareLeadsButton').addEventListener('click', shareAllLeads);

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
    id: `${Date.now()}-${Math.random().toString(36).slice(2,9)}`,
    name: text(raw.name),
    company: text(raw.company ?? raw.companyName),
    phone: formatPhoneNumber(raw.phone ?? raw.phoneNumber),
    site: text(raw.site ?? raw.website ?? raw.url),
    age: text(raw.age ?? raw.siteAge),
    issue: text(raw.issue ?? raw.mainIssue),
    status: 'new',
    lastCalled: '',
    tag: '',
    spanishPossible: Boolean(raw.spanishPossible ?? raw.spanish ?? false),
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
  saveState();
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
  // Skip rows that already match an existing lead, while still allowing blank fields.
  const normalizePhone = value => String(value ?? '').replace(/\D/g, '');
  const normalizeText = value => String(value ?? '').trim().toLowerCase();

  const isDuplicate = raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;

    const rawId = normalizeText(raw.id);
    if (rawId && state.leads.some(lead => normalizeText(lead.id) === rawId)) return true;

    const rawPhone = normalizePhone(raw.phone ?? raw.phoneNumber);
    if (rawPhone && state.leads.some(lead => normalizePhone(lead.phone) === rawPhone)) return true;

    const rawName = normalizeText(raw.name);
    const rawCompany = normalizeText(raw.company ?? raw.companyName);
    const rawSite = normalizeText(raw.site ?? raw.website ?? raw.url);

    // If there is no phone/ID, use the identifying text that is actually present.
    if (rawName || rawCompany || rawSite) {
      return state.leads.some(lead =>
        normalizeText(lead.name) === rawName &&
        normalizeText(lead.company) === rawCompany &&
        normalizeText(lead.site) === rawSite
      );
    }

    // A completely blank row has no stable identity, so keep it importable as requested.
    return false;
  };

  const imported = [];
  let skipped = 0;

  rows.forEach(row => {
    const raw = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
    if (isDuplicate(raw)) {
      skipped += 1;
      return;
    }

    const lead = makeLead(raw);
    state.leads.push(lead);
    imported.push(lead);
  });

  saveState();
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
