// 使用原生 popover 管理焦点和关闭行为，日历与选项内容保持系统字体。
const PanelUI = (() => {
  const $ = (id) => document.getElementById(id), pad = (n) => String(n).padStart(2, '0');
  const parts = ['Year', 'Month', 'Day', 'Hour', 'Minute', 'Second'], lastDates = {};
  let target = 'start', draft = new Date(), month, year, reasons = [];
  function position(popover, anchor, width) {
    const rect = anchor.getBoundingClientRect(), w = Math.min(width, innerWidth - 24);
    popover.style.width = w + 'px'; popover.style.left = Math.max(12, Math.min(rect.left, innerWidth - w - 12)) + 'px';
    const height = popover.getBoundingClientRect().height;
    const below = rect.bottom + 7;
    popover.style.top = (below + height <= innerHeight - 12 ? below : Math.max(12, rect.top - height - 7)) + 'px';
    popover.style.maxHeight = (innerHeight - 24) + 'px';
  }
  function setDate(id, value) {
    $(id).value = value;
    const values = value.match(/\d+/g) || [];
    parts.forEach((part, n) => { $(id + part).value = values[n] || ''; });
    if (BagCore.inputTime(value)) lastDates[id] = value;
    $(id + 'Error').hidden = true; $(id + 'Control').removeAttribute('aria-invalid');
    $(id + 'Button').setAttribute('aria-label', `详细设置${id === 'start' ? '开始' : '结束'}时间 ${value.replace('T', ' ')}`);
  }
  function syncInline(id, showError = false) {
    const values = parts.map((part) => $(id + part).value);
    const text = `${values[0]}-${pad(values[1])}-${pad(values[2])}T${pad(values[3])}:${pad(values[4])}:${pad(values[5])}`;
    const valid = values.every((v) => /^\d+$/.test(v)) && values[0].length === 4 && BagCore.inputTime(text);
    $(id).value = valid ? text : '';
    if (valid) lastDates[id] = text;
    $(id + 'Button').setAttribute('aria-label', `详细设置${id === 'start' ? '开始' : '结束'}时间${valid ? ' ' + text.replace('T', ' ') : ''}`);
    $(id + 'Control').setAttribute('aria-invalid', String(!valid && showError)); $(id + 'Error').hidden = !!valid || !showError;
    $(id).dispatchEvent(new Event('change', { bubbles: true }));
  }
  function initInline(id) {
    parts.forEach((part, n) => {
      const input = $(id + part);
      input.addEventListener('focus', () => input.select());
      input.addEventListener('click', () => input.select());
      input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, part === 'Year' ? 4 : 2); syncInline(id); });
      input.addEventListener('blur', () => { if (input.value && part !== 'Year') input.value = pad(input.value); syncInline(id, true); });
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
          ev.preventDefault(); $(id + parts[(n + (ev.key === 'ArrowRight' ? 1 : -1) + parts.length) % parts.length]).focus();
        } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
          ev.preventDefault();
          const date = new Date($(id).value || lastDates[id] || Date.now()), step = ev.key === 'ArrowUp' ? 1 : -1;
          const setters = ['FullYear', 'Month', 'Date', 'Hours', 'Minutes', 'Seconds'];
          if (part === 'Month' || part === 'Year') {
            const day = date.getDate(); date.setDate(1); date['set' + setters[n]](date['get' + setters[n]]() + step);
            date.setDate(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
          } else date['set' + setters[n]](date['get' + setters[n]]() + step);
          setDate(id, BagCore.localTime(date).replace(' ', 'T')); syncInline(id); input.select();
        } else if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
      });
    });
  }
  function renderCalendar() {
    $('calendarTitle').textContent = `${year} 年 ${month + 1} 月`;
    const grid = $('calendarDays'); grid.textContent = '';
    const first = new Date(year, month, 1), offset = (first.getDay() + 6) % 7, today = new Date();
    for (let n = 0; n < 42; n++) {
      const date = new Date(year, month, n - offset + 1), button = document.createElement('button');
      const chosen = date.toDateString() === draft.toDateString();
      button.type = 'button'; button.textContent = String(date.getDate());
      button.className = 'calendar-day' + (date.getMonth() !== month ? ' outside' : '') + (chosen ? ' selected' : '') + (date.toDateString() === today.toDateString() ? ' today' : '');
      button.setAttribute('aria-label', `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`);
      button.setAttribute('aria-pressed', String(chosen));
      button.addEventListener('click', () => {
        draft.setFullYear(date.getFullYear(), date.getMonth(), date.getDate()); year = date.getFullYear(); month = date.getMonth(); renderCalendar();
        grid.querySelector('.selected')?.focus({ preventScroll: true });
      }); grid.append(button);
    }
  }
  function openDate(id) {
    close(); target = id; draft = new Date($(id).value || lastDates[id] || Date.now()); year = draft.getFullYear(); month = draft.getMonth();
    $('dateHour').value = pad(draft.getHours()); $('dateMinute').value = pad(draft.getMinutes()); $('dateSecond').value = pad(draft.getSeconds()); $('dateError').hidden = true;
    renderCalendar(); $('datePopover').showPopover(); position($('datePopover'), $(id + 'Control'), 302);
    $('calendarDays').querySelector('.selected')?.focus({ preventScroll: true });
  }
  function close() {
    for (const id of ['datePopover', 'reasonPopover']) if ($(id).matches(':popover-open')) $(id).hidePopover();
  }
  function renderReasons(rows) {
    reasons = rows; const options = $('reasonOptions'); options.textContent = '';
    for (const r of [{ value: '', name: '请选择回传原因' }, ...rows]) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'reason-option'; button.dataset.value = r.value;
      button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(String(r.value) === $('reason').value));
      const label = document.createElement('span'); label.textContent = r.name; button.append(label);
      button.addEventListener('click', () => {
        $('reason').value = String(r.value); $('reasonText').textContent = r.name; renderReasons(reasons); close(); $('reasonButton').focus({ preventScroll: true });
        $('reason').dispatchEvent(new Event('change', { bubbles: true }));
      }); options.append(button);
    }
    $('reasonText').textContent = rows.find((r) => String(r.value) === $('reason').value)?.name || '请选择回传原因';
  }
  function init() {
    for (const id of ['start', 'end']) { initInline(id); $(id + 'Button').addEventListener('click', () => openDate(id)); }
    $('monthPrev').addEventListener('click', () => { const d = new Date(year, month - 1, 1); year = d.getFullYear(); month = d.getMonth(); renderCalendar(); });
    $('monthNext').addEventListener('click', () => { const d = new Date(year, month + 1, 1); year = d.getFullYear(); month = d.getMonth(); renderCalendar(); });
    $('dateToday').addEventListener('click', () => { const d = new Date(); draft.setFullYear(d.getFullYear(), d.getMonth(), d.getDate()); year = d.getFullYear(); month = d.getMonth(); renderCalendar(); });
    $('dateCancel').addEventListener('click', () => { close(); $(target + 'Button').focus({ preventScroll: true }); });
    $('dateApply').addEventListener('click', () => {
      const inputs = ['dateHour', 'dateMinute', 'dateSecond'].map($);
      if (inputs.some((input) => !input.value || !input.validity.valid)) { $('dateError').textContent = '请填写有效的时、分、秒'; $('dateError').hidden = false; return; }
      draft.setHours(...inputs.map((input) => Number(input.value)), 0);
      setDate(target, BagCore.localTime(draft).replace(' ', 'T')); close(); $(target + 'Button').focus({ preventScroll: true });
      $(target).dispatchEvent(new Event('change', { bubbles: true }));
    });
    $('datePopover').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') { ev.preventDefault(); $('dateApply').click(); } });
    $('datePopover').addEventListener('toggle', () => {
      for (const id of ['start', 'end']) $(id + 'Button').setAttribute('aria-expanded', String(id === target && $('datePopover').matches(':popover-open')));
    });
    $('reasonButton').addEventListener('click', () => {
      if ($('reasonPopover').matches(':popover-open')) { close(); return; }
      close(); $('reasonPopover').showPopover(); position($('reasonPopover'), $('reasonButton'), $('reasonButton').getBoundingClientRect().width);
      ($('reasonOptions').querySelector('[aria-selected="true"]') || $('reasonOptions').firstChild)?.focus({ preventScroll: true });
    });
    $('reasonPopover').addEventListener('toggle', () => $('reasonButton').setAttribute('aria-expanded', String($('reasonPopover').matches(':popover-open'))));
    $('reasonOptions').addEventListener('keydown', (ev) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key)) return;
      ev.preventDefault(); const options = [...$('reasonOptions').children], index = options.indexOf(document.activeElement);
      const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? options.length - 1 : (index + (ev.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      options[next]?.focus({ preventScroll: true });
    });
    window.addEventListener('resize', close);
    $('taskSetup').addEventListener('toggle', () => { if (!$('taskSetup').open) close(); });
  }
  return { init, setDate, renderReasons, close };
})();
