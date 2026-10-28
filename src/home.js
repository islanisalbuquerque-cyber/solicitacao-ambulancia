(() => {
  const byId = (id) => document.getElementById(id);
  const state = { user: null, requests: [], options: null, usersLoading: false, usersLoaded: false, optionsLoading: false, requestPending: false, userPending: false, deletePending: false, dashboardInitialized: false, deciding: new Set() };
  let requestsTask = null;
  let deleteTarget = null;
  const statuses = { pendente: 'Pendente', aprovada: 'Aprovada', reprovada: 'Reprovada' };
  const formatter = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' });

  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  };
  const icon = (name, className = '') => window.AmbulanceIcons?.create(name, className);
  const buttonContent = (button, iconName, label) => {
    const glyph = icon(iconName);
    const text = node('span', 'button-label', label);
    button.replaceChildren(...(glyph ? [glyph, text] : [text]));
  };
  const statusContent = (element, text, iconName) => {
    element.classList.toggle('is-empty', Boolean(iconName));
    const glyph = iconName && icon(iconName);
    if (glyph) {
      const symbol = node('span', 'empty-state-icon');
      symbol.append(glyph);
      element.replaceChildren(symbol, node('span', 'status-label', text));
    } else {
      element.textContent = text;
    }
  };
  const formatDate = (value) => {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime()) ? formatter.format(date) : 'Não informado';
  };
  const listText = (value) => Array.isArray(value) ? value.join(', ') : 'Não informado';
  const roleLabel = (role) => role === 'master' ? 'MASTER' : 'MLP';
  const feedback = (id, message, kind = 'error', focus = false) => {
    const element = byId(id);
    element.className = `feedback ${kind}`;
    element.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    element.textContent = message;
    element.hidden = !message;
    if (focus && message) element.focus();
  };

  const api = async (url, options = {}) => {
    let response;
    try {
      response = await fetch(url, {
        ...options,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers,
      });
    } catch {
      throw new Error('Não foi possível conectar ao servidor. Verifique a conexão e tente novamente.');
    }
    if (response.status === 401) {
      window.location.replace('/');
      const error = new Error('Sua sessão expirou. Entre novamente.');
      error.status = 401;
      throw error;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const fallback = response.status === 403 ? 'Seu perfil não tem permissão para realizar esta ação.' : 'Não foi possível concluir a operação. Tente novamente.';
      const error = new Error(response.status === 403 ? fallback : (typeof data?.error === 'string' ? data.error : fallback));
      error.status = response.status;
      throw error;
    }
    return data;
  };

  const selected = (name) => Array.from(document.querySelectorAll(`#requestForm input[name="${name}"]:checked`), (input) => input.value);
  const validateChoices = (name) => {
    const valid = selected(name).length === 1;
    byId(`${name}Choices`).setAttribute('aria-invalid', String(!valid));
    return valid;
  };
  const renderChoices = (name, values, retainedValue) => {
    const container = byId(`${name}Choices`);
    container.replaceChildren();
    values.forEach((value, index) => {
      const label = node('label', 'choice-option');
      const input = node('input');
      input.type = 'radio';
      input.name = name;
      input.id = `${name}-${index}`;
      input.value = value;
      input.checked = value === retainedValue;
      input.setAttribute('aria-describedby', `${name}Hint`);
      input.addEventListener('change', () => {
        validateChoices(name);
        if (name === 'svcs') updateDependentChoices();
      });
      label.append(input, node('span', '', value));
      container.append(label);
    });
    container.removeAttribute('aria-invalid');
  };
  const updateDependentChoices = () => {
    const svc = selected('svcs')[0];
    const options = svc && state.options?.svcOptions[svc];
    const hints = {
      carriers: 'Selecione um SVC para ver as transportadoras disponíveis.',
      xpts: 'Selecione um SVC para ver os XPTs disponíveis.',
    };
    for (const name of ['carriers', 'xpts']) {
      const container = byId(`${name}Choices`);
      if (options) {
        renderChoices(name, options[name], selected(name)[0]);
        container.hidden = false;
        byId(`${name}Hint`).textContent = 'Selecione uma opção.';
      } else {
        container.replaceChildren();
        container.hidden = true;
        container.removeAttribute('aria-invalid');
        byId(`${name}Hint`).textContent = hints[name];
      }
    }
  };
  const validOptionList = (values) => Array.isArray(values) && values.length > 0
    && values.every((value) => typeof value === 'string' && value.trim() === value && value.length > 0)
    && new Set(values).size === values.length;
  const validFormOptions = (options) => {
    if (!validOptionList(options?.svcs) || !validOptionList(options?.reasons)
      || !options.svcOptions || typeof options.svcOptions !== 'object' || Array.isArray(options.svcOptions)) return false;
    return options.svcs.every((svc) => Object.hasOwn(options.svcOptions, svc)
      && validOptionList(options.svcOptions[svc]?.carriers)
      && validOptionList(options.svcOptions[svc]?.xpts));
  };
  const loadOptions = async () => {
    if (state.optionsLoading) return;
    state.optionsLoading = true;
    byId('requestFields').disabled = true;
    byId('retryOptions').hidden = true;
    byId('optionsStatus').hidden = false;
    byId('optionsStatus').textContent = 'Carregando opções do formulário…';
    try {
      const options = await api('/api/options');
      if (!validFormOptions(options)) {
        throw new Error('As opções do formulário não estão disponíveis. Tente carregá-las novamente.');
      }
      state.options = options;
      for (const key of ['svcs', 'reasons']) renderChoices(key, options[key], selected(key)[0]);
      updateDependentChoices();
      byId('requestFields').disabled = false;
      byId('optionsStatus').hidden = true;
    } catch (error) {
      byId('optionsStatus').textContent = error.message;
      byId('retryOptions').hidden = false;
    } finally {
      state.optionsLoading = false;
    }
  };

  const fillIdentity = () => {
    byId('requestName').value = state.user.name;
    byId('requestEmail').value = state.user.email;
  };
  const updateCounts = () => {
    byId('countAll').textContent = String(state.requests.length);
    byId('countPending').textContent = String(state.requests.filter((request) => request.status === 'pendente').length);
    byId('countApproved').textContent = String(state.requests.filter((request) => request.status === 'aprovada').length);
    byId('countRejected').textContent = String(state.requests.filter((request) => request.status === 'reprovada').length);
  };
  const syncDashboard = () => {
    if (state.user?.role === 'master' && state.dashboardInitialized) window.AmbulanceDashboard.setRequests(state.requests);
  };
  const detail = (grid, label, value) => {
    const item = node('div', 'detail-item');
    item.append(node('dt', '', label), node('dd', '', value ?? 'Não informado'));
    grid.append(item);
  };

  const createDecisionForm = (request) => {
    const form = node('form', 'decision-form');
    form.method = 'post';
    const field = node('div', 'form-field');
    const label = node('label', '', 'Observação da decisão (opcional)');
    label.htmlFor = `decision-note-${request.id}`;
    const note = node('textarea');
    note.id = label.htmlFor;
    note.name = 'note';
    note.rows = 3;
    note.maxLength = 1000;
    field.append(label, note, node('small', '', 'Até 1.000 caracteres.'));
    const actions = node('div', 'decision-actions');
    const approve = node('button', 'btn btn-primary');
    buttonContent(approve, 'check', 'Aprovar');
    approve.type = 'submit';
    approve.value = 'aprovada';
    const reject = node('button', 'btn btn-danger');
    buttonContent(reject, 'x', 'Reprovar');
    reject.type = 'submit';
    reject.value = 'reprovada';
    actions.append(approve, reject);
    const message = node('div', 'feedback error');
    message.setAttribute('role', 'alert');
    message.tabIndex = -1;
    message.hidden = true;
    form.append(field, actions, message);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const decisionStatus = event.submitter?.value;
      if (!['aprovada', 'reprovada'].includes(decisionStatus) || state.deciding.has(request.id)) return;
      state.deciding.add(request.id);
      approve.disabled = true;
      reject.disabled = true;
      message.hidden = true;
      const activeButton = decisionStatus === 'aprovada' ? approve : reject;
      buttonContent(activeButton, 'clock', 'Salvando…');
      try {
        const result = await api(`/api/requests/${encodeURIComponent(request.id)}/decision`, {
          method: 'POST',
          body: JSON.stringify({ status: decisionStatus, note: note.value.trim() }),
        });
        if (!result?.request) throw new Error('Não foi possível confirmar a decisão. Atualize a lista antes de tentar novamente.');
        state.requests = state.requests.map((item) => item.id === request.id ? result.request : item);
        syncDashboard();
        updateCounts();
        renderRequests();
        feedback('requestsFeedback', `Solicitação ${result.request.protocol} ${decisionStatus === 'aprovada' ? 'aprovada' : 'reprovada'} com sucesso.`, 'success', true);
      } catch (error) {
        if (error.status === 409) {
          const refreshed = await loadRequests();
          feedback('requestsFeedback', refreshed ? 'Esta solicitação já recebeu uma decisão. A lista foi atualizada.' : 'Esta solicitação já recebeu uma decisão. Use Atualizar para consultar o resultado.', 'error', true);
        } else {
          message.textContent = error.message;
          message.hidden = false;
          message.focus();
        }
      } finally {
        state.deciding.delete(request.id);
        approve.disabled = false;
        reject.disabled = false;
        buttonContent(approve, 'check', 'Aprovar');
        buttonContent(reject, 'x', 'Reprovar');
      }
    });
    return form;
  };

  const createRequestCard = (request) => {
    const card = node('details', 'request-card');
    const summary = node('summary', 'request-summary');
    const symbol = node('span', 'request-symbol');
    const glyph = icon('ambulance');
    if (glyph) symbol.append(glyph);
    const identity = node('div', 'request-identity');
    identity.append(node('strong', '', request.protocol), node('span', '', `Rota ${request.routeId}`));
    const operation = node('div', 'request-operation');
    operation.append(node('span', '', `SVC: ${listText(request.svcs)}`), node('span', '', `XPT: ${listText(request.xpts)}`));
    if (request.carrier) operation.append(node('span', '', `Transportadora: ${request.carrier}`));
    const badgeClass = Object.hasOwn(statuses, request.status) ? request.status : 'pendente';
    const badge = node('span', `status-badge ${badgeClass}`, statuses[request.status] || 'Não informado');
    const timestamp = node('time', '', formatDate(request.createdAt));
    timestamp.dateTime = request.createdAt || '';
    summary.append(symbol, identity, operation, badge, timestamp);
    const body = node('div', 'request-details');
    const grid = node('dl', 'detail-grid');
    detail(grid, 'Protocolo', request.protocol);
    detail(grid, 'Solicitante', request.name);
    detail(grid, 'E-mail', request.email);
    detail(grid, 'SVC', listText(request.svcs));
    detail(grid, 'Transportadora', request.carrier || 'Não informada');
    detail(grid, 'XPT', listText(request.xpts));
    detail(grid, 'ID da rota', request.routeId);
    detail(grid, 'Modal carregado', request.loadedModal);
    detail(grid, 'Quantidade de pacotes', request.packageCount);
    detail(grid, 'Quantidade de paradas', request.stopCount);
    detail(grid, 'Modal para ambulância', request.ambulanceModal);
    detail(grid, 'Motivos', listText(request.reasons));
    detail(grid, 'Data da solicitação', formatDate(request.createdAt));
    detail(grid, 'Status', statuses[request.status] || 'Não informado');
    body.append(grid);
    if (request.decision) {
      body.append(node('h3', 'section-heading', 'Decisão'));
      const decisionGrid = node('dl', 'detail-grid');
      detail(decisionGrid, 'Responsável', request.decision.byName);
      detail(decisionGrid, 'E-mail do responsável', request.decision.byEmail);
      detail(decisionGrid, 'Data da decisão', formatDate(request.decision.at));
      detail(decisionGrid, 'Observação', request.decision.note || 'Sem observação.');
      body.append(decisionGrid);
    } else {
      body.append(node('p', 'pending-note', 'Aguardando análise do perfil MASTER.'));
    }
    if (state.user.role === 'master' && request.status === 'pendente') body.append(createDecisionForm(request));
    card.append(summary, body);
    return card;
  };

  const renderRequests = () => {
    const status = byId('statusFilter').value;
    const search = byId('requestSearch').value.trim().toLocaleLowerCase('pt-BR');
    const requests = state.requests.filter((request) => {
      const text = [request.protocol, request.routeId, request.name, request.email, request.carrier].join(' ').toLocaleLowerCase('pt-BR');
      return (status === 'all' || request.status === status) && (!search || text.includes(search));
    });
    byId('requestList').replaceChildren(...requests.map(createRequestCard));
    const message = byId('requestsStatus');
    message.hidden = false;
    const text = !state.requests.length ? 'Nenhuma solicitação cadastrada.' : !requests.length ? 'Nenhuma solicitação corresponde aos filtros.' : `${requests.length} ${requests.length === 1 ? 'solicitação encontrada' : 'solicitações encontradas'}.`;
    statusContent(message, text, !state.requests.length ? 'clipboard' : !requests.length ? 'search' : undefined);
  };

  const loadRequests = () => {
    if (requestsTask) return requestsTask;
    requestsTask = (async () => {
      byId('refreshRequests').disabled = true;
      byId('requestList').setAttribute('aria-busy', 'true');
      byId('requestsStatus').hidden = false;
      statusContent(byId('requestsStatus'), 'Carregando solicitações…');
      try {
        const data = await api('/api/requests');
        if (!Array.isArray(data?.requests)) throw new Error('O servidor retornou uma lista inválida. Tente atualizar novamente.');
        state.requests = [...data.requests].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        syncDashboard();
        updateCounts();
        renderRequests();
        return true;
      } catch (error) {
        statusContent(byId('requestsStatus'), 'Não foi possível atualizar as solicitações.');
        feedback('requestsFeedback', error.message);
        return false;
      } finally {
        byId('refreshRequests').disabled = false;
        byId('requestList').removeAttribute('aria-busy');
        requestsTask = null;
      }
    })();
    return requestsTask;
  };

  const openDeleteUser = (user) => {
    if (state.user?.role !== 'master' || state.deletePending || user.id === state.user.id) return;
    deleteTarget = { id: user.id, name: user.name, email: user.email };
    byId('deleteUserName').textContent = user.name;
    byId('deleteUserEmail').textContent = user.email;
    feedback('deleteUserFeedback', '');
    byId('deleteUserDialog').showModal();
  };

  byId('cancelDeleteUser').addEventListener('click', () => {
    if (!state.deletePending) byId('deleteUserDialog').close();
  });
  byId('deleteUserDialog').addEventListener('cancel', (event) => {
    if (state.deletePending) event.preventDefault();
  });
  byId('deleteUserDialog').addEventListener('close', () => {
    deleteTarget = null;
    feedback('deleteUserFeedback', '');
  });
  byId('deleteUserForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.deletePending || !deleteTarget || state.user?.role !== 'master' || deleteTarget.id === state.user.id) return;
    const target = deleteTarget;
    state.deletePending = true;
    byId('cancelDeleteUser').disabled = true;
    byId('confirmDeleteUser').disabled = true;
    buttonContent(byId('confirmDeleteUser'), 'clock', 'Excluindo…');
    feedback('deleteUserFeedback', '');
    try {
      const result = await api(`/api/users/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
      if (result?.ok !== true) throw new Error('Não foi possível confirmar a exclusão. Atualize a lista antes de tentar novamente.');
      byId('deleteUserDialog').close();
      feedback('usersFeedback', `O acesso de ${target.name} foi excluído. Os registros anteriores foram mantidos.`, 'success', true);
      await loadUsers();
    } catch (error) {
      feedback('deleteUserFeedback', error.message, 'error', true);
      if (error.status === 409) await loadUsers();
    } finally {
      state.deletePending = false;
      byId('cancelDeleteUser').disabled = false;
      byId('confirmDeleteUser').disabled = false;
      buttonContent(byId('confirmDeleteUser'), 'trash', 'Excluir usuário');
    }
  });

  const loadUsers = async () => {
    if (state.usersLoading || state.user.role !== 'master') return;
    state.usersLoading = true;
    byId('refreshUsers').disabled = true;
    byId('usersStatus').hidden = false;
    statusContent(byId('usersStatus'), 'Carregando usuários…');
    byId('usersTableWrap').setAttribute('aria-busy', 'true');
    try {
      const data = await api('/api/users');
      if (!Array.isArray(data?.users)) throw new Error('Não foi possível carregar a lista de usuários.');
      const rows = data.users.map((user) => {
        const row = node('tr');
        row.append(node('td', '', user.name), node('td', '', user.email), node('td', '', roleLabel(user.role)), node('td', '', formatDate(user.createdAt)));
        const actions = node('td');
        if (user.id === state.user.id) {
          actions.append(node('span', '', 'Seu usuário'));
        } else {
          const remove = node('button', 'btn btn-danger');
          buttonContent(remove, 'trash', 'Excluir');
          remove.type = 'button';
          remove.setAttribute('aria-label', `Excluir usuário ${user.name}`);
          remove.addEventListener('click', () => openDeleteUser(user));
          actions.append(remove);
        }
        row.append(actions);
        return row;
      });
      byId('usersTableBody').replaceChildren(...rows);
      byId('usersTableWrap').hidden = !rows.length;
      statusContent(byId('usersStatus'), rows.length ? `${rows.length} ${rows.length === 1 ? 'acesso cadastrado' : 'acessos cadastrados'}.` : 'Nenhum usuário cadastrado.', rows.length ? undefined : 'users');
      state.usersLoaded = true;
    } catch (error) {
      statusContent(byId('usersStatus'), 'Não foi possível atualizar os usuários.');
      feedback('usersFeedback', error.message);
    } finally {
      state.usersLoading = false;
      byId('refreshUsers').disabled = false;
      byId('usersTableWrap').removeAttribute('aria-busy');
    }
  };

  const activateTab = (name) => {
    const target = document.querySelector(`.app-tabs [data-tab="${name}"]`);
    if (!target || target.hidden) return;
    document.querySelectorAll('.app-tabs [data-tab]').forEach((button) => {
      const active = button === target;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      byId(button.getAttribute('aria-controls')).hidden = !active;
    });
    if (name === 'users' && !state.usersLoaded) loadUsers();
    if (name === 'dashboard' && state.dashboardInitialized) window.AmbulanceDashboard.activate();
  };

  document.querySelectorAll('.app-tabs [data-tab]').forEach((button) => {
    button.addEventListener('click', () => activateTab(button.dataset.tab));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = Array.from(document.querySelectorAll('.app-tabs [data-tab]')).filter((tab) => !tab.hidden);
      const index = tabs.indexOf(button);
      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[nextIndex].focus();
      activateTab(tabs[nextIndex].dataset.tab);
    });
  });
  byId('statusFilter').addEventListener('change', renderRequests);
  byId('requestSearch').addEventListener('input', renderRequests);
  byId('refreshRequests').addEventListener('click', () => { feedback('requestsFeedback', ''); loadRequests(); });
  byId('refreshUsers').addEventListener('click', () => { feedback('usersFeedback', ''); loadUsers(); });
  byId('retryOptions').addEventListener('click', loadOptions);
  byId('requestForm').addEventListener('reset', () => queueMicrotask(updateDependentChoices));

  byId('requestForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.requestPending || state.user?.role !== 'mlp') return;
    if (!event.currentTarget.reportValidity()) return;
    const groups = { svcs: 'SVC', carriers: 'Transportadora', xpts: 'XPT', reasons: 'Motivo da solicitação' };
    const missing = Object.keys(groups).find((name) => !validateChoices(name));
    if (missing) {
      feedback('requestFeedback', `Selecione uma opção em ${groups[missing]}.`);
      byId(`${missing}Choices`).querySelector('input')?.focus();
      return;
    }
    const payload = {
      name: byId('requestName').value.trim(), email: byId('requestEmail').value,
      svcs: selected('svcs'), carrier: selected('carriers')[0], xpts: selected('xpts'), routeId: byId('routeId').value.trim(),
      loadedModal: byId('loadedModal').value.trim(), packageCount: Number(byId('packageCount').value),
      stopCount: Number(byId('stopCount').value), ambulanceModal: byId('ambulanceModal').value.trim(), reasons: selected('reasons'),
    };
    state.requestPending = true;
    byId('requestFields').disabled = true;
    buttonContent(byId('requestSubmit'), 'clock', 'Enviando…');
    feedback('requestFeedback', '');
    try {
      const result = await api('/api/requests', { method: 'POST', body: JSON.stringify(payload) });
      if (!result?.request) throw new Error('Não foi possível confirmar o envio. Consulte o histórico antes de tentar novamente.');
      byId('requestForm').reset();
      byId('requestName').value = payload.name;
      byId('requestEmail').value = payload.email;
      updateDependentChoices();
      for (const name of ['svcs', 'carriers', 'xpts', 'reasons']) byId(`${name}Choices`).removeAttribute('aria-invalid');
      feedback('requestFeedback', `Solicitação ${result.request.protocol} enviada com sucesso. Status: Pendente, aguardando análise.`, 'success', true);
      state.requests = [result.request, ...state.requests.filter((request) => request.id !== result.request.id)];
      syncDashboard();
      updateCounts();
      renderRequests();
      await loadRequests();
    } catch (error) {
      feedback('requestFeedback', error.message, 'error', true);
    } finally {
      state.requestPending = false;
      byId('requestFields').disabled = false;
      buttonContent(byId('requestSubmit'), 'send', 'Enviar solicitação');
    }
  });

  byId('userForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.userPending || state.user?.role !== 'master' || !event.currentTarget.reportValidity()) return;
    state.userPending = true;
    byId('userSubmit').disabled = true;
    buttonContent(byId('userSubmit'), 'clock', 'Cadastrando…');
    feedback('usersFeedback', '');
    try {
      const result = await api('/api/users', {
        method: 'POST',
        body: JSON.stringify({ name: byId('newUserName').value.trim(), email: byId('newUserEmail').value.trim(), password: byId('newUserPassword').value, role: byId('newUserRole').value }),
      });
      if (!result?.user) throw new Error('Não foi possível confirmar o cadastro. Atualize a lista antes de tentar novamente.');
      byId('userForm').reset();
      byId('newUserPassword').value = '';
      feedback('usersFeedback', `Acesso de ${result.user.name} cadastrado com perfil ${roleLabel(result.user.role)}.`, 'success', true);
      await loadUsers();
    } catch (error) {
      feedback('usersFeedback', error.message, 'error', true);
    } finally {
      state.userPending = false;
      byId('userSubmit').disabled = false;
      buttonContent(byId('userSubmit'), 'plus', 'Cadastrar usuário');
    }
  });

  byId('logoutButton').addEventListener('click', async () => {
    const button = byId('logoutButton');
    if (button.disabled) return;
    button.disabled = true;
    buttonContent(button, 'logout', 'Saindo…');
    feedback('appFeedback', '');
    try {
      const result = await api('/api/logout', { method: 'POST' });
      if (result?.ok !== true) throw new Error('Não foi possível encerrar a sessão. Tente novamente.');
      window.location.replace('/');
    } catch (error) {
      feedback('appFeedback', error.message, 'error', true);
    } finally {
      button.disabled = false;
      buttonContent(button, 'logout', 'Sair');
    }
  });

  const initialize = async () => {
    if (window.location.protocol === 'file:') {
      byId('sessionStatus').hidden = true;
      feedback('sessionError', 'Para entrar, abra o aplicativo pelo endereço exibido ao iniciar o servidor local.', 'error', true);
      return;
    }
    try {
      const result = await api('/api/session');
      const user = result?.user;
      if (!user || typeof user.name !== 'string' || typeof user.email !== 'string' || !['mlp', 'master'].includes(user.role)) throw new Error('Não foi possível verificar sua conta. Atualize a página para tentar novamente.');
      state.user = user;
      byId('userName').textContent = user.name;
      byId('userEmail').textContent = user.email;
      byId('userRole').textContent = roleLabel(user.role);
      byId('accountMenu').hidden = false;
      byId('sessionState').hidden = true;
      byId('appShell').hidden = false;
      if (user.role === 'master') {
        byId('tab-users').hidden = false;
        byId('tab-dashboard').hidden = false;
        const requestsTab = byId('tab-requests');
        (requestsTab.querySelector('.tab-label') || requestsTab).textContent = 'Solicitações';
        byId('requestsHeading').textContent = 'Solicitações';
        byId('requestsDescription').textContent = 'Analise as solicitações e registre a aprovação ou reprovação.';
        if (window.AmbulanceDashboard && typeof window.AmbulanceDashboard.initialize === 'function') {
          window.AmbulanceDashboard.initialize({ api, refreshRequests: loadRequests });
          state.dashboardInitialized = true;
        } else {
          byId('dashboardRoot').textContent = 'Não foi possível carregar o Dashboard. Atualize a página para tentar novamente.';
        }
        activateTab('requests');
        await loadRequests();
      } else {
        byId('tab-new').hidden = false;
        fillIdentity();
        activateTab('new');
        await Promise.allSettled([loadOptions(), loadRequests()]);
      }
    } catch (error) {
      byId('sessionStatus').hidden = true;
      feedback('sessionError', error.message, 'error', true);
    }
  };
  initialize();
})();
