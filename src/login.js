(() => {
  const form = document.getElementById('loginForm');
  const email = document.getElementById('email');
  const password = document.getElementById('password');
  const togglePassword = document.getElementById('togglePassword');
  const submitButton = document.getElementById('submitButton');
  const loginError = document.getElementById('loginError');

  if (!form || !email || !password || !loginError) return;

  let pending = false;

  const clearMessage = () => {
    loginError.hidden = true;
    loginError.textContent = '';
  };

  const showMessage = (message) => {
    loginError.textContent = message;
    loginError.hidden = false;
    loginError.tabIndex = -1;
    loginError.focus();
  };

  email.addEventListener('input', clearMessage);
  password.addEventListener('input', clearMessage);

  if (togglePassword) {
    togglePassword.type = 'button';
    togglePassword.addEventListener('click', () => {
      const visible = password.type === 'password';
      password.type = visible ? 'text' : 'password';
      togglePassword.setAttribute('aria-pressed', String(visible));
      togglePassword.setAttribute('aria-label', visible ? 'Ocultar senha' : 'Mostrar senha');

      const label = togglePassword.querySelector('[data-password-label]');
      if (label) label.textContent = visible ? 'Ocultar' : 'Mostrar';
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending) return;

    if (document.documentElement.dataset.authMode === 'preview' || window.location.protocol === 'file:') {
      showMessage('Para entrar, abra o aplicativo pelo endereço exibido ao iniciar o servidor local.');
      return;
    }

    clearMessage();
    pending = true;
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'Entrando…';
    }
    form.setAttribute('aria-busy', 'true');

    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.value.trim(), password: password.value }),
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok || result.ok !== true) {
        const message = typeof result.error === 'string' && result.error.trim()
          ? result.error
          : 'Não foi possível entrar. Confira seus dados e tente novamente.';
        showMessage(message);
        return;
      }

      password.value = '';
      window.location.assign('/inicio');
    } catch {
      showMessage('Não foi possível conectar ao servidor. Verifique se ele está em execução e tente novamente.');
    } finally {
      pending = false;
      form.removeAttribute('aria-busy');
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = 'Entrar';
      }
    }
  });
})();
