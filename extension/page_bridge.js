(() => {
  if (window.__MXRA_PAGE_BRIDGE__) return;
  window.__MXRA_PAGE_BRIDGE__ = true;
  document.documentElement.dataset.mxraBridgeReady = '1';

  function reactPropsFor(el) {
    if (!el) return [];
    const props = [];
    for (const key of Object.keys(el)) {
      if (key.startsWith('__reactProps$') || key.startsWith('__reactEventHandlers$')) {
        props.push(el[key]);
      }
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
        let fiber = el[key];
        for (let i = 0; i < 8 && fiber; i++, fiber = fiber.return) {
          if (fiber.memoizedProps) props.push(fiber.memoizedProps);
          if (fiber.pendingProps) props.push(fiber.pendingProps);
        }
      }
    }
    return props.filter(Boolean);
  }

  function eventFor(target, nativeEvent) {
    let defaultPrevented = false;
    let propagationStopped = false;
    return {
      nativeEvent,
      target,
      currentTarget: target,
      type: 'click',
      bubbles: true,
      cancelable: true,
      defaultPrevented,
      eventPhase: 3,
      isTrusted: false,
      preventDefault() { defaultPrevented = true; },
      stopPropagation() { propagationStopped = true; },
      isDefaultPrevented() { return defaultPrevented; },
      isPropagationStopped() { return propagationStopped; },
      persist() {}
    };
  }

  function changeEventFor(input, nativeEvent) {
    return {
      ...eventFor(input, nativeEvent),
      type: 'change',
      target: input,
      currentTarget: input
    };
  }

  function fireNativeClick(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const EventCtor = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
      el.dispatchEvent(new EventCtor(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: type.includes('down') ? 1 : 0
      }));
    }
    try { el.click(); } catch (_) {}
  }

  function callReactClick(el) {
    const root = el.closest('button,a,[role="button"],label') || el;
    const candidates = [
      el,
      root,
      ...Array.from(root.querySelectorAll('*')),
      root.parentElement
    ].filter(Boolean);
    const nativeEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window, button: 0 });

    for (const target of candidates) {
      for (const props of reactPropsFor(target)) {
        if (typeof props.onClick === 'function') {
          props.onClick(eventFor(target, nativeEvent));
          return true;
        }
      }
    }
    return false;
  }

  function checkboxInputFor(el) {
    return el && el.matches && el.matches('input[type="checkbox"]')
      ? el
      : el && el.querySelector && el.querySelector('input[type="checkbox"]');
  }

  function radioInputFor(el) {
    return el && el.matches && el.matches('input[type="radio"]')
      ? el
      : el && el.querySelector && el.querySelector('input[type="radio"]');
  }

  function editableInputFor(el) {
    return el && el.matches && el.matches('input,textarea')
      ? el
      : el && el.querySelector && el.querySelector('input:not([type="radio"]):not([type="checkbox"]),textarea');
  }

  function setNativeChecked(input, checked) {
    const before = input.checked;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
    if (setter) setter.call(input, checked);
    else input.checked = checked;

    const tracker = input._valueTracker;
    if (tracker) tracker.setValue(String(before));
  }

  function setNativeValue(input, value) {
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const before = input.value;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, String(value));
    else input.value = String(value);

    const tracker = input._valueTracker;
    if (tracker) tracker.setValue(String(before));
  }

  function callReactChange(input, checked) {
    const nativeEvent = new Event('change', { bubbles: true, cancelable: true });
    let called = false;
    const candidates = [
      input,
      input.parentElement,
      input.closest('label,.MuiCheckbox-root,.MuiRadio-root,.MuiButtonBase-root,.MuiFormControlLabel-root,[role="checkbox"],[role="radio"]')
    ].filter(Boolean);

    for (const target of candidates) {
      for (const props of reactPropsFor(target)) {
        if (typeof props.onChange === 'function') {
          try {
            props.onChange(changeEventFor(input, nativeEvent), checked);
            called = true;
          } catch (error) {
            console.debug('[MXRA bridge] onChange failed', error);
          }
        }
      }
    }
    return called;
  }

  function setCheckbox(el, checked) {
    const input = checkboxInputFor(el);
    if (!input) {
      if (el && el.getAttribute && el.getAttribute('role') === 'checkbox') {
        el.setAttribute('aria-checked', checked ? 'true' : 'false');
        el.classList.toggle('checked', Boolean(checked));
        return true;
      }
      return false;
    }
    const clickTarget = input.closest('label,.MuiCheckbox-root,.MuiButtonBase-root,.MuiFormControlLabel-root,[role="checkbox"]') || input;
    setNativeChecked(input, !checked);
    fireNativeClick(clickTarget);
    if (input.checked === checked) return true;

    setNativeChecked(input, checked);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: String(checked) }));
    input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    callReactChange(input, checked);
    return input.checked === checked;
  }

  function setRadio(el) {
    const input = radioInputFor(el);
    if (!input) {
      if (el && el.getAttribute && el.getAttribute('role') === 'radio') {
        const group = el.closest('[role="radiogroup"],tr,.mxra-radio-row') || el.parentElement;
        if (group) {
          group.querySelectorAll('[role="radio"]').forEach(peer => {
            peer.setAttribute('aria-checked', peer === el ? 'true' : 'false');
            peer.classList.toggle('checked', peer === el);
          });
        } else {
          el.setAttribute('aria-checked', 'true');
        }
        return true;
      }
      return false;
    }
    const clickTarget = input.closest('label,.MuiRadio-root,.MuiButtonBase-root,.MuiFormControlLabel-root,[role="radio"]') || input;
    setNativeChecked(input, false);
    fireNativeClick(clickTarget);
    if (input.checked) return true;

    if (input.name) {
      const root = input.form || document;
      root.querySelectorAll(`input[type="radio"][name="${CSS.escape(input.name)}"]`).forEach(peer => {
        if (peer !== input) setNativeChecked(peer, false);
      });
    }
    setNativeChecked(input, true);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: 'true' }));
    input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    callReactChange(input, true);
    return input.checked === true;
  }

  function setInputValue(el, value) {
    const input = editableInputFor(el);
    if (!input) return false;
    setNativeValue(input, value);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: String(value) }));
    input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    callReactChange(input, value);
    return String(input.value) === String(value);
  }

  window.addEventListener('mxra:react-click', event => {
    const token = (event.detail && event.detail.token) ||
      document.documentElement.getAttribute('data-mxra-click-request');
    let ok = false;
    try {
      const selector = `[data-mxra-click-token="${CSS.escape(token)}"]`;
      const el = token ? document.querySelector(selector) : null;
      if (el) {
        fireNativeClick(el);
        ok = callReactClick(el);
      }
    } catch (error) {
      console.debug('[MXRA bridge] click failed', error);
    }
    if (token) document.documentElement.setAttribute('data-mxra-click-result', token);
    window.dispatchEvent(new CustomEvent('mxra:react-click-result', { detail: { token, ok } }));
  });

  window.addEventListener('mxra:checkbox-set', event => {
    const token = (event.detail && event.detail.token) ||
      document.documentElement.getAttribute('data-mxra-checkbox-request');
    const checked = (event.detail && event.detail.checked) ??
      document.documentElement.getAttribute('data-mxra-checkbox-checked') === '1';
    let ok = false;
    try {
      const selector = `[data-mxra-checkbox-token="${CSS.escape(token)}"]`;
      const el = token ? document.querySelector(selector) : null;
      if (el) ok = setCheckbox(el, Boolean(checked));
    } catch (error) {
      console.debug('[MXRA bridge] checkbox set failed', error);
    }
    if (token) document.documentElement.setAttribute('data-mxra-checkbox-result', token);
    window.dispatchEvent(new CustomEvent('mxra:checkbox-set-result', { detail: { token, ok } }));
  });

  window.addEventListener('mxra:radio-set', event => {
    const token = (event.detail && event.detail.token) ||
      document.documentElement.getAttribute('data-mxra-radio-request');
    let ok = false;
    try {
      const selector = `[data-mxra-radio-token="${CSS.escape(token)}"]`;
      const el = token ? document.querySelector(selector) : null;
      if (el) ok = setRadio(el);
    } catch (error) {
      console.debug('[MXRA bridge] radio set failed', error);
    }
    if (token) document.documentElement.setAttribute('data-mxra-radio-result', token);
    window.dispatchEvent(new CustomEvent('mxra:radio-set-result', { detail: { token, ok } }));
  });

  window.addEventListener('mxra:input-set', event => {
    const token = (event.detail && event.detail.token) ||
      document.documentElement.getAttribute('data-mxra-input-request');
    const value = (event.detail && event.detail.value) ??
      document.documentElement.getAttribute('data-mxra-input-value') ?? '';
    let ok = false;
    try {
      const selector = `[data-mxra-input-token="${CSS.escape(token)}"]`;
      const el = token ? document.querySelector(selector) : null;
      if (el) ok = setInputValue(el, value);
    } catch (error) {
      console.debug('[MXRA bridge] input set failed', error);
    }
    if (token) document.documentElement.setAttribute('data-mxra-input-result', token);
    window.dispatchEvent(new CustomEvent('mxra:input-set-result', { detail: { token, ok } }));
  });
})();