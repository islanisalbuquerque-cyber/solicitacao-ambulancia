(() => {
  'use strict';

  const zone = 'America/Sao_Paulo';
  const notInformed = '__not_informed__';
  const statuses = [
    { value: 'pendente', label: 'Pendentes', singular: 'Pendente', className: 'dash-pending' },
    { value: 'aprovada', label: 'Aprovadas', singular: 'Aprovada', className: 'dash-approved' },
    { value: 'reprovada', label: 'Reprovadas', singular: 'Reprovada', className: 'dash-rejected' },
  ];
  const filterDefinitions = [
    { key: 'dateFrom', label: 'Data inicial', type: 'date' },
    { key: 'dateTo', label: 'Data final', type: 'date' },
    { key: 'svc', label: 'SVC', optionKey: 'svcs', all: 'Todos os SVCs' },
    { key: 'xpt', label: 'XPT', optionKey: 'xpts', all: 'Todos os XPTs' },
    { key: 'carrier', label: 'Transportadora', optionKey: 'carriers', all: 'Todas as transportadoras' },
    { key: 'status', label: 'Status', all: 'Todos os status' },
    { key: 'reason', label: 'Motivo', optionKey: 'reasons', all: 'Todos os motivos' },
  ];
  const numbers = new Intl.NumberFormat('pt-BR');
  const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: zone });
  const dateParts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: zone });
  const state = {
    root: null, api: null, refreshRequests: null, requests: [], loaded: false,
    options: null, optionsTask: null, refreshing: false, updatedAt: null,
    filters: Object.fromEntries(filterDefinitions.map(({ key }) => [key, ''])),
    refs: {}, focusable: new Map(),
  };

  const node = (tag, className = '', text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  };
  const icon = (name, className = '') => window.AmbulanceIcons?.create(name, className) || node('span');
  const buttonContent = (button, name, label) => button.replaceChildren(icon(name), node('span', 'button-label', label));
  const svgNode = (tag, attributes = {}, text) => {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    if (text !== undefined) element.textContent = String(text);
    return element;
  };
  const strings = (values) => Array.isArray(values) ? [...new Set(values.filter((value) => typeof value === 'string' && value.trim()))] : [];
  const carrierOf = (request) => typeof request.carrier === 'string' && request.carrier.trim() ? request.carrier.trim() : notInformed;
  const carrierLabel = (value) => value === notInformed ? 'Não informada' : value;
  const fmt = (value) => numbers.format(value);
  const noun = (count) => count === 1 ? 'solicitação' : 'solicitações';
  const timestamp = (value) => {
    const time = new Date(value || '').getTime();
    return Number.isFinite(time) ? time : null;
  };
  const formatDate = (value) => timestamp(value) === null ? 'Não informado' : dateTime.format(new Date(value));
  const dayKey = (value) => {
    if (timestamp(value) === null) return '';
    const parts = Object.fromEntries(dateParts.formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const dayLabel = (key, withYear = false) => {
    const [year, month, day] = key.split('-');
    return withYear ? `${day}/${month}/${year}` : `${day}/${month}`;
  };
  const validDateRange = () => !state.filters.dateFrom || !state.filters.dateTo || state.filters.dateFrom <= state.filters.dateTo;
  const focusToken = (field, value) => JSON.stringify([field, value]);
  const rememberButton = (button, field, value) => {
    const token = focusToken(field, value);
    button.dataset.dashFocus = token;
    state.focusable.set(token, button);
  };
  const setNotice = (message = '', error = false) => {
    state.refs.notice.textContent = message;
    state.refs.notice.hidden = !message;
    state.refs.notice.className = `dash-notice${error ? ' dash-notice-error' : ''}`;
    state.refs.notice.setAttribute('role', error ? 'alert' : 'status');
  };

  function updateSelectOptions() {
    if (!state.root) return;
    for (const definition of filterDefinitions.filter(({ type }) => type !== 'date')) {
      const control = state.refs.controls[definition.key];
      const selected = state.filters[definition.key];
      let entries;
      if (definition.key === 'status') {
        entries = statuses.map(({ value, label }) => [value, label]);
      } else {
        let actual;
        if (definition.key === 'carrier') actual = state.requests.map(carrierOf);
        else actual = state.requests.flatMap((request) => request[definition.optionKey]);
        const canonical = strings(state.options?.[definition.optionKey]);
        const values = [...new Set([...canonical, ...actual, ...(selected ? [selected] : [])])];
        if (definition.key === 'carrier' && !values.includes(notInformed)) values.push(notInformed);
        entries = values.map((value) => [value, definition.key === 'carrier' ? carrierLabel(value) : value]);
      }
      const all = node('option', '', definition.all);
      all.value = '';
      const options = entries.map(([value, label]) => {
        const option = node('option', '', label);
        option.value = value;
        return option;
      });
      control.replaceChildren(all, ...options);
      control.value = selected;
    }
  }

  function applyChartFilter(field, value) {
    state.filters[field] = state.filters[field] === value ? '' : value;
    state.refs.controls[field].value = state.filters[field];
    render();
  }

  function applyDayFilter(value) {
    const alreadySelected = state.filters.dateFrom === value && state.filters.dateTo === value;
    state.filters.dateFrom = alreadySelected ? '' : value;
    state.filters.dateTo = alreadySelected ? '' : value;
    state.refs.controls.dateFrom.value = state.filters.dateFrom;
    state.refs.controls.dateTo.value = state.filters.dateTo;
    render();
  }

  function filteredRequests() {
    if (!validDateRange()) return [];
    const filters = state.filters;
    return state.requests.filter((request) => {
      const day = dayKey(request.createdAt);
      return (!filters.dateFrom || (day && day >= filters.dateFrom)) &&
        (!filters.dateTo || (day && day <= filters.dateTo)) &&
        (!filters.svc || request.svcs.includes(filters.svc)) &&
        (!filters.xpt || request.xpts.includes(filters.xpt)) &&
        (!filters.carrier || carrierOf(request) === filters.carrier) &&
        (!filters.status || request.status === filters.status) &&
        (!filters.reason || request.reasons.includes(filters.reason));
    });
  }

  function emptyChart(target) {
    target.replaceChildren(node('p', 'dash-chart-empty', state.loaded ? 'Nenhuma solicitação no recorte atual.' : 'Aguardando as solicitações…'));
  }

  function groups(requests, valuesFor) {
    const counts = new Map();
    requests.forEach((request) => {
      [...new Set(valuesFor(request))].forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
    });
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pt-BR'));
  }

  function renderRanking(target, entries, field, labelFor = (value) => value) {
    if (!entries.length) return emptyChart(target);
    const max = Math.max(...entries.map(([, count]) => count));
    const list = node('ul', 'dash-ranking');
    entries.forEach(([value, count]) => {
      const row = node('li');
      const button = node('button', 'dash-rank-button');
      button.type = 'button';
      const label = labelFor(value);
      const active = state.filters[field] === value;
      button.setAttribute('aria-pressed', String(active));
      button.setAttribute('aria-label', `${active ? 'Remover filtro' : 'Filtrar por'} ${label}: ${fmt(count)} ${noun(count)}.`);
      rememberButton(button, field, value);
      const head = node('span', 'dash-rank-head');
      head.append(node('span', 'dash-rank-label', label), node('strong', 'dash-rank-count', fmt(count)));
      const bar = svgNode('svg', { viewBox: '0 0 320 9', preserveAspectRatio: 'none', class: 'dash-rank-bar', 'aria-hidden': 'true' });
      bar.append(
        svgNode('rect', { x: 0, y: 0, width: 320, height: 9, rx: 4.5, class: 'dash-bar-track' }),
        svgNode('rect', { x: 0, y: 0, width: Math.max(1, count / max * 320).toFixed(2), height: 9, rx: 4.5, class: 'dash-bar-fill' }),
      );
      button.append(head, bar);
      button.addEventListener('click', () => applyChartFilter(field, value));
      row.append(button);
      list.append(row);
    });
    target.replaceChildren(list);
  }

  function renderStatus(requests) {
    const target = state.refs.statusChart;
    if (!requests.length) return emptyChart(target);
    const total = requests.length;
    const chart = node('div', 'dash-status-layout');
    const visual = node('div', 'dash-donut');
    const svg = svgNode('svg', { viewBox: '0 0 160 160', 'aria-hidden': 'true' });
    const circumference = 2 * Math.PI * 58;
    svg.append(svgNode('circle', { cx: 80, cy: 80, r: 58, class: 'dash-ring-track' }));
    const legend = node('div', 'dash-status-legend');
    let offset = 0;
    statuses.forEach((status) => {
      const count = requests.filter((request) => request.status === status.value).length;
      if (count) {
        const length = count / total * circumference;
        const segment = svgNode('circle', {
          cx: 80, cy: 80, r: 58, class: `dash-ring-segment ${status.className}`,
          'stroke-dasharray': `${length} ${circumference - length}`,
          'stroke-dashoffset': -offset, transform: 'rotate(-90 80 80)',
        });
        segment.append(svgNode('title', {}, `${status.label}: ${fmt(count)}`));
        segment.addEventListener('click', () => applyChartFilter('status', status.value));
        svg.append(segment);
        offset += length;
      }
      const button = node('button', `dash-status-button ${status.className}`);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(state.filters.status === status.value));
      button.setAttribute('aria-label', `Filtrar ${status.label.toLocaleLowerCase('pt-BR')}: ${fmt(count)} ${noun(count)}.`);
      rememberButton(button, 'status', status.value);
      const label = node('span', 'dash-status-label');
      const dot = node('span', 'dash-status-dot');
      dot.setAttribute('aria-hidden', 'true');
      label.append(dot, node('span', '', status.label));
      const values = node('span', 'dash-status-values');
      values.append(node('strong', '', fmt(count)), node('small', '', `${numbers.format(Math.round(count / total * 100))}%`));
      button.append(label, values);
      button.addEventListener('click', () => applyChartFilter('status', status.value));
      legend.append(button);
    });
    const center = node('div', 'dash-donut-center');
    center.append(node('strong', '', fmt(total)), node('span', '', noun(total)));
    visual.append(svg, center);
    chart.append(visual, legend);
    target.replaceChildren(chart);
  }

  function renderTrend(requests) {
    const target = state.refs.trendChart;
    const entries = groups(requests, (request) => {
      const day = dayKey(request.createdAt);
      return day ? [day] : [];
    }).sort((a, b) => a[0].localeCompare(b[0]));
    if (!entries.length) return emptyChart(target);
    const chartWidth = Math.max(640, entries.length * 42 + 88);
    const chartHeight = 225;
    const left = 48;
    const right = chartWidth - 24;
    const top = 20;
    const baseline = 180;
    const max = Math.max(...entries.map(([, count]) => count));
    const slot = (right - left) / entries.length;
    const width = Math.min(26, slot * 0.65);
    const svg = svgNode('svg', {
      viewBox: `0 0 ${chartWidth} ${chartHeight}`, width: chartWidth, height: chartHeight,
      class: 'dash-trend-svg', role: 'img', 'aria-labelledby': 'dashTrendSvgTitle dashTrendSvgDescription',
    });
    svg.append(
      svgNode('title', { id: 'dashTrendSvgTitle' }, 'Evolução diária das solicitações'),
      svgNode('desc', { id: 'dashTrendSvgDescription' }, `${entries.length} ${entries.length === 1 ? 'dia' : 'dias'} com solicitações. Datas em São Paulo. Os valores e filtros por dia estão disponíveis após o gráfico.`),
    );
    const ticks = [...new Set([0, Math.ceil(max / 2), max])].sort((a, b) => a - b);
    ticks.forEach((tick) => {
      const y = baseline - tick / max * (baseline - top);
      svg.append(
        svgNode('line', { x1: left, x2: right, y1: y, y2: y, class: 'dash-trend-grid' }),
        svgNode('text', { x: left - 10, y: y + 4, 'text-anchor': 'end', class: 'dash-axis-label' }, fmt(tick)),
      );
    });
    entries.forEach(([day, count], index) => {
      const x = left + slot * (index + 0.5);
      const height = count / max * (baseline - top);
      const bar = svgNode('rect', { x: x - width / 2, y: baseline - height, width, height, rx: 3, class: 'dash-trend-bar' });
      bar.append(svgNode('title', {}, `${dayLabel(day, true)}: ${fmt(count)} ${noun(count)}`));
      bar.addEventListener('click', () => applyDayFilter(day));
      svg.append(bar);
      if (entries.length <= 14 || index % Math.ceil(entries.length / 12) === 0 || index === entries.length - 1) {
        svg.append(svgNode('text', { x, y: 202, 'text-anchor': 'middle', class: 'dash-axis-label' }, dayLabel(day)));
      }
    });
    const scroll = node('div', 'dash-trend-scroll');
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    scroll.setAttribute('aria-label', 'Gráfico diário; role horizontalmente para ver todo o período.');
    scroll.append(svg);
    const details = node('details', 'dash-daily-details');
    details.append(node('summary', '', 'Ver valores e filtrar por dia'));
    const list = node('ul', 'dash-daily-values');
    entries.forEach(([day, count]) => {
      const row = node('li');
      const button = node('button', 'dash-day-button', `${dayLabel(day, true)} · ${fmt(count)} ${noun(count)}`);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(state.filters.dateFrom === day && state.filters.dateTo === day));
      rememberButton(button, 'day', day);
      button.addEventListener('click', () => applyDayFilter(day));
      row.append(button);
      list.append(row);
    });
    details.append(list);
    target.replaceChildren(scroll, node('p', 'dash-chart-hint', 'Somente dias com registros. Selecione um dia para consultar esse recorte.'), details);
  }

  function renderTable(requests) {
    const ordered = [...requests].sort((a, b) => (timestamp(b.createdAt) ?? 0) - (timestamp(a.createdAt) ?? 0));
    const shown = ordered.slice(0, 50);
    state.refs.tableCount.textContent = requests.length > 50
      ? `Exibindo as 50 mais recentes de ${fmt(requests.length)} solicitações no recorte.`
      : `${fmt(requests.length)} ${noun(requests.length)} no recorte, da mais recente para a mais antiga.`;
    state.refs.tableScroll.hidden = !shown.length;
    state.refs.tableEmpty.hidden = Boolean(shown.length);
    state.refs.tableEmpty.textContent = !state.loaded ? 'Aguardando as solicitações…' : !state.requests.length
      ? 'Nenhuma solicitação cadastrada. Os indicadores aparecerão quando houver solicitações.'
      : 'Nenhuma solicitação corresponde aos filtros. Ajuste o recorte ou limpe os filtros.';
    const rows = shown.map((request) => {
      const row = node('tr');
      const values = [request.protocol, formatDate(request.createdAt), request.svcs.join(', '), request.xpts.join(', '), carrierLabel(carrierOf(request)), request.routeId];
      values.forEach((value) => row.append(node('td', '', value || 'Não informado')));
      const status = statuses.find(({ value }) => value === request.status);
      const statusCell = node('td');
      statusCell.append(node('span', `dash-table-status ${status?.className || 'dash-unknown'}`, status?.singular || 'Não informado'));
      row.append(statusCell, node('td', 'dash-number', fmt(request.packageCount)), node('td', 'dash-number', fmt(request.stopCount)));
      return row;
    });
    state.refs.tableBody.replaceChildren(...rows);
  }

  function render() {
    if (!state.root) return;
    const previousFocus = document.activeElement?.dataset.dashFocus;
    const dailyDetailsOpen = state.refs.trendChart.querySelector('details')?.open || false;
    state.focusable.clear();
    const requests = filteredRequests();
    const totals = {
      total: requests.length,
      pendente: requests.filter((request) => request.status === 'pendente').length,
      aprovada: requests.filter((request) => request.status === 'aprovada').length,
      reprovada: requests.filter((request) => request.status === 'reprovada').length,
      packages: requests.reduce((sum, request) => sum + request.packageCount, 0),
      stops: requests.reduce((sum, request) => sum + request.stopCount, 0),
    };
    for (const [key, element] of Object.entries(state.refs.kpiValues)) element.textContent = state.loaded ? fmt(totals[key]) : '—';
    for (const [key, button] of Object.entries(state.refs.kpiButtons)) button.setAttribute('aria-pressed', String(state.filters.status === key));
    state.refs.dateError.hidden = validDateRange();
    state.refs.summary.textContent = state.loaded
      ? `${fmt(requests.length)} de ${fmt(state.requests.length)} ${noun(state.requests.length)} no recorte.`
      : 'Aguardando as solicitações…';
    state.refs.clear.disabled = !Object.values(state.filters).some(Boolean);
    state.refs.updated.textContent = state.updatedAt ? `Atualizado em ${dateTime.format(state.updatedAt)}` : 'Dados ainda não carregados';
    renderStatus(requests);
    renderRanking(state.refs.carrierChart, groups(requests, (request) => [carrierOf(request)]), 'carrier', carrierLabel);
    renderRanking(state.refs.svcChart, groups(requests, (request) => request.svcs), 'svc');
    renderRanking(state.refs.reasonChart, groups(requests, (request) => request.reasons), 'reason');
    state.refs.svcHint.textContent = requests.some((request) => request.svcs.length > 1)
      ? 'Pedidos antigos com mais de um SVC contam uma vez em cada SVC.' : 'Cada barra conta as solicitações do SVC.';
    state.refs.reasonHint.textContent = requests.some((request) => request.reasons.length > 1)
      ? 'Uma solicitação com vários motivos conta uma vez em cada motivo.' : 'Cada barra conta as solicitações do motivo.';
    renderTrend(requests);
    const nextDailyDetails = state.refs.trendChart.querySelector('details');
    if (nextDailyDetails) nextDailyDetails.open = dailyDetailsOpen;
    renderTable(requests);
    if (previousFocus) state.focusable.get(previousFocus)?.focus({ preventScroll: true });
  }

  function chartCard(title, description, id, wide = false) {
    const card = node('section', `dash-chart-card${wide ? ' dash-chart-wide' : ''}`);
    const heading = node('h3', 'dash-section-title', title);
    const chartIcons = { dashStatusChart: 'chart', dashCarrierChart: 'truck', dashSvcChart: 'building', dashReasonChart: 'clipboard', dashTrendChart: 'route' };
    heading.prepend(icon(chartIcons[id] || 'chart', 'dash-title-icon'));
    heading.id = `${id}Heading`;
    card.setAttribute('aria-labelledby', heading.id);
    const hint = node('p', 'dash-chart-hint', description);
    const content = node('div', 'dash-chart-content');
    content.id = id;
    card.append(heading, hint, content);
    state.refs.chartGrid.append(card);
    return { content, hint };
  }

  async function ensureOptions() {
    if (state.options || state.optionsTask || !state.root) return state.optionsTask;
    state.refs.retryOptions.hidden = true;
    state.refs.optionState.hidden = false;
    state.refs.optionState.textContent = 'Carregando opções dos filtros…';
    state.optionsTask = (async () => {
      try {
        const options = await state.api('/api/options');
        if (!['svcs', 'xpts', 'carriers', 'reasons'].every((key) => Array.isArray(options?.[key]) && options[key].every((value) => typeof value === 'string' && value.trim()))) {
          throw new Error('Não foi possível carregar todas as opções dos filtros.');
        }
        state.options = options;
        updateSelectOptions();
        state.refs.optionState.hidden = true;
      } catch (error) {
        state.refs.optionState.textContent = `${error.message} Os filtros dos registros carregados continuam disponíveis.`;
        state.refs.retryOptions.hidden = false;
      } finally {
        state.optionsTask = null;
      }
    })();
    return state.optionsTask;
  }

  function initialize({ api, refreshRequests }) {
    if (state.root) return;
    const root = document.getElementById('dashboardRoot');
    if (!root) throw new Error('O painel do dashboard não está disponível.');
    if (typeof api !== 'function' || typeof refreshRequests !== 'function') throw new Error('O dashboard precisa da conexão com a aplicação.');
    state.root = root;
    state.api = api;
    state.refreshRequests = refreshRequests;
    root.classList.add('dash-root');
    const heading = node('div', 'page-heading dash-heading');
    const intro = node('div', 'dash-intro');
    const headingMark = node('span', 'heading-icon');
    headingMark.setAttribute('aria-hidden', 'true');
    headingMark.append(icon('chart'));
    const headingCopy = node('div', 'heading-copy');
    headingCopy.append(node('span', 'view-kicker', 'VISÃO DA OPERAÇÃO'), node('h2', '', 'Dashboard'), node('p', '', 'Acompanhe os volumes e as decisões das solicitações de ambulância.'));
    intro.append(headingMark, headingCopy);
    const actions = node('div', 'dash-heading-actions');
    state.refs.updated = node('p', 'dash-updated');
    const refresh = node('button', 'btn btn-primary dash-refresh', 'Atualizar');
    buttonContent(refresh, 'refresh', 'Atualizar');
    refresh.type = 'button';
    refresh.addEventListener('click', async () => {
      if (state.refreshing) return;
      state.refreshing = true;
      refresh.disabled = true;
      buttonContent(refresh, 'refresh', 'Atualizando…');
      root.setAttribute('aria-busy', 'true');
      setNotice();
      try {
        const success = await state.refreshRequests();
        if (success === false) throw new Error('Não foi possível atualizar as solicitações. Tente novamente.');
        setNotice('Solicitações atualizadas. Os filtros foram mantidos.');
      } catch (error) {
        setNotice(error.message || 'Não foi possível atualizar as solicitações.', true);
      } finally {
        state.refreshing = false;
        refresh.disabled = false;
        buttonContent(refresh, 'refresh', 'Atualizar');
        root.removeAttribute('aria-busy');
      }
    });
    actions.append(state.refs.updated, refresh);
    heading.append(intro, actions);
    state.refs.notice = node('div', 'dash-notice');
    state.refs.notice.hidden = true;

    const filters = node('section', 'dash-surface dash-filters');
    const filterHeading = node('h3', 'dash-section-title', 'Filtros');
    filterHeading.prepend(icon('search', 'dash-title-icon'));
    filterHeading.id = 'dashFiltersHeading';
    filters.setAttribute('aria-labelledby', filterHeading.id);
    const filterTop = node('div', 'dash-filter-top');
    state.refs.clear = node('button', 'dash-clear', 'Limpar filtros');
    state.refs.clear.type = 'button';
    state.refs.clear.addEventListener('click', () => {
      for (const definition of filterDefinitions) {
        state.filters[definition.key] = '';
        state.refs.controls[definition.key].value = '';
      }
      render();
    });
    filterTop.append(filterHeading, state.refs.clear);
    const filterGrid = node('div', 'dash-filter-grid');
    state.refs.controls = {};
    for (const definition of filterDefinitions) {
      const field = node('div', 'dash-field');
      const label = node('label', '', definition.label);
      const control = node(definition.type === 'date' ? 'input' : 'select');
      control.id = `dashFilter-${definition.key}`;
      label.htmlFor = control.id;
      if (definition.type) control.type = definition.type;
      control.addEventListener('change', () => {
        state.filters[definition.key] = control.value;
        render();
      });
      state.refs.controls[definition.key] = control;
      field.append(label, control);
      filterGrid.append(field);
    }
    state.refs.dateError = node('p', 'dash-date-error', 'A data inicial deve ser anterior ou igual à data final.');
    state.refs.dateError.setAttribute('role', 'alert');
    state.refs.dateError.hidden = true;
    const filterBottom = node('div', 'dash-filter-bottom');
    state.refs.summary = node('p', 'dash-results');
    state.refs.summary.setAttribute('role', 'status');
    state.refs.summary.setAttribute('aria-live', 'polite');
    filterBottom.append(state.refs.summary, node('p', 'dash-timezone', 'Datas inclusivas · horário de São Paulo'));
    state.refs.optionState = node('p', 'dash-option-state');
    state.refs.optionState.setAttribute('role', 'status');
    state.refs.optionState.hidden = true;
    state.refs.retryOptions = node('button', 'dash-clear', 'Tentar carregar opções');
    state.refs.retryOptions.type = 'button';
    state.refs.retryOptions.hidden = true;
    state.refs.retryOptions.addEventListener('click', () => { void ensureOptions(); });
    filters.append(filterTop, filterGrid, state.refs.dateError, filterBottom, state.refs.optionState, state.refs.retryOptions);

    const kpis = node('div', 'dash-kpis');
    kpis.setAttribute('role', 'group');
    kpis.setAttribute('aria-label', 'Indicadores do recorte');
    state.refs.kpiValues = {};
    state.refs.kpiButtons = {};
    const kpiDefinitions = [
      { key: 'total', label: 'Solicitações', hint: 'Total no recorte', className: 'dash-total' },
      ...statuses.map((status) => ({ key: status.value, label: status.label, hint: 'Selecione para filtrar', className: status.className })),
      { key: 'packages', label: 'Pacotes', hint: 'Volume solicitado', className: 'dash-volume' },
      { key: 'stops', label: 'Paradas', hint: 'Volume solicitado', className: 'dash-volume' },
    ];
    for (const definition of kpiDefinitions) {
      const clickable = statuses.some(({ value }) => value === definition.key);
      const card = node(clickable ? 'button' : 'div', `dash-kpi ${definition.className}${clickable ? ' dash-kpi-button' : ''}`);
      const value = node('strong', 'dash-kpi-value', '—');
      if (clickable) {
        card.type = 'button';
        card.setAttribute('aria-pressed', 'false');
        card.addEventListener('click', () => applyChartFilter('status', definition.key));
        state.refs.kpiButtons[definition.key] = card;
      }
      state.refs.kpiValues[definition.key] = value;
      const kpiIcons = { total: 'clipboard', pendente: 'clock', aprovada: 'check', reprovada: 'x', packages: 'package', stops: 'pin' };
      const symbol = node('span', 'dash-kpi-symbol');
      symbol.setAttribute('aria-hidden', 'true');
      symbol.append(icon(kpiIcons[definition.key]));
      card.append(symbol);
      card.append(node('span', 'dash-kpi-label', definition.label), value, node('small', 'dash-kpi-hint', definition.hint));
      kpis.append(card);
    }

    state.refs.chartGrid = node('div', 'dash-charts');
    state.refs.statusChart = chartCard('Distribuição por status', 'Selecione um status para filtrar o painel.', 'dashStatusChart').content;
    state.refs.carrierChart = chartCard('Solicitações por transportadora', 'Selecione uma transportadora para filtrar o painel.', 'dashCarrierChart').content;
    const svc = chartCard('Solicitações por SVC', 'Cada barra conta as solicitações do SVC.', 'dashSvcChart');
    state.refs.svcChart = svc.content;
    state.refs.svcHint = svc.hint;
    const reason = chartCard('Solicitações por motivo', 'Cada barra conta as solicitações do motivo.', 'dashReasonChart');
    state.refs.reasonChart = reason.content;
    state.refs.reasonHint = reason.hint;
    state.refs.trendChart = chartCard('Evolução diária', 'Solicitações por data de criação, no horário de São Paulo.', 'dashTrendChart', true).content;

    const tableSection = node('section', 'dash-surface dash-table-section');
    const tableHeading = node('h3', 'dash-section-title', 'Solicitações do recorte');
    tableHeading.prepend(icon('clipboard', 'dash-title-icon'));
    tableHeading.id = 'dashTableHeading';
    tableSection.setAttribute('aria-labelledby', tableHeading.id);
    state.refs.tableCount = node('p', 'dash-chart-hint');
    state.refs.tableScroll = node('div', 'dash-table-scroll');
    state.refs.tableScroll.tabIndex = 0;
    state.refs.tableScroll.setAttribute('role', 'region');
    state.refs.tableScroll.setAttribute('aria-label', 'Tabela de solicitações; role horizontalmente para ver todas as colunas.');
    const table = node('table', 'dash-table');
    const caption = node('caption', 'dash-sr-only', 'Até 50 solicitações mais recentes que correspondem aos filtros.');
    const thead = node('thead');
    const row = node('tr');
    ['Protocolo', 'Data', 'SVC', 'XPT', 'Transportadora', 'Rota', 'Status', 'Pacotes', 'Paradas'].forEach((text, index) => {
      const cell = node('th', index > 6 ? 'dash-number' : '', text);
      cell.scope = 'col';
      row.append(cell);
    });
    thead.append(row);
    state.refs.tableBody = node('tbody');
    table.append(caption, thead, state.refs.tableBody);
    state.refs.tableScroll.append(table);
    state.refs.tableEmpty = node('p', 'dash-chart-empty');
    tableSection.append(tableHeading, state.refs.tableCount, state.refs.tableScroll, state.refs.tableEmpty);
    root.replaceChildren(heading, state.refs.notice, filters, kpis, state.refs.chartGrid, tableSection);
    updateSelectOptions();
    render();
  }

  function setRequests(requests) {
    state.requests = (Array.isArray(requests) ? requests : []).filter((request) => request && typeof request === 'object').map((request) => ({
      ...request, svcs: strings(request.svcs), xpts: strings(request.xpts), reasons: strings(request.reasons),
      packageCount: Number.isFinite(Number(request.packageCount)) ? Math.max(0, Number(request.packageCount)) : 0,
      stopCount: Number.isFinite(Number(request.stopCount)) ? Math.max(0, Number(request.stopCount)) : 0,
    }));
    state.loaded = true;
    state.updatedAt = new Date();
    updateSelectOptions();
    render();
  }

  async function activate() {
    if (!state.root) return;
    render();
    await ensureOptions();
  }

  window.AmbulanceDashboard = Object.freeze({ initialize, setRequests, activate });
})();
