(() => {
  "use strict";

  const viewport = window.visualViewport;
  const isIOS =
    /\b(iPad|iPhone|iPod)\b/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  let viewportFrame = 0;
  function updateVisibleViewport() {
    const root = document.documentElement;
    root.style.setProperty("--herdr-tty-viewport-height", `${Math.ceil(viewport?.height ?? window.innerHeight)}px`);
    root.style.setProperty("--herdr-tty-viewport-width", `${Math.ceil(viewport?.width ?? window.innerWidth)}px`);
    root.style.setProperty("--herdr-tty-viewport-top", `${Math.round(viewport?.offsetTop ?? 0)}px`);
    root.style.setProperty("--herdr-tty-viewport-left", `${Math.round(viewport?.offsetLeft ?? 0)}px`);
  }
  function scheduleViewportUpdate() {
    cancelAnimationFrame(viewportFrame);
    viewportFrame = requestAnimationFrame(updateVisibleViewport);
  }
  viewport?.addEventListener("resize", scheduleViewportUpdate, { passive: true });
  viewport?.addEventListener("scroll", scheduleViewportUpdate, { passive: true });
  window.addEventListener("resize", scheduleViewportUpdate, { passive: true });
  window.addEventListener("orientationchange", scheduleViewportUpdate, { passive: true });
  updateVisibleViewport();

  let pendingIOSPunctuation = null;

  function isIOSVirtualPunctuation(event) {
    return (
      isIOS &&
      !event.defaultPrevented &&
      !event.isComposing &&
      event.inputType === "insertText" &&
      !!event.data &&
      /^\p{P}+$/u.test(event.data) &&
      event.target?.classList?.contains("xterm-helper-textarea") &&
      typeof window.term?.input === "function"
    );
  }

  function sendIOSPunctuation(data) {
    window.term.input(data, true);
  }

  document.addEventListener(
    "beforeinput",
    (event) => {
      // xterm.js #5835: iOS exposes virtual Chinese punctuation here, but its
      // keyCode 229 path can drop the corresponding terminal input.
      if (!isIOSVirtualPunctuation(event)) return;

      const target = event.target;
      pendingIOSPunctuation = {
        data: event.data,
        selectionEnd: target.selectionEnd,
        selectionStart: target.selectionStart,
        target,
        value: target.value,
      };
      event.stopImmediatePropagation();
      if (event.cancelable) {
        event.preventDefault();
        pendingIOSPunctuation = null;
        sendIOSPunctuation(event.data);
      }
    },
    { capture: true, passive: false },
  );

  document.addEventListener(
    "input",
    (event) => {
      const pending = pendingIOSPunctuation;
      if (
        !pending ||
        event.target !== pending.target ||
        event.inputType !== "insertText" ||
        event.data !== pending.data
      ) {
        return;
      }

      pendingIOSPunctuation = null;
      event.stopImmediatePropagation();
      pending.target.value = pending.value;
      if (typeof pending.target.setSelectionRange === "function") {
        pending.target.setSelectionRange(pending.selectionStart, pending.selectionEnd);
      }
      sendIOSPunctuation(pending.data);
    },
    { capture: true },
  );

  document.addEventListener("contextmenu", (event) => {
    // Keep the terminal's own menu suppressed (two-finger tap is right-click),
    // but allow the native long-press menu on the bottom paste input: on LAN
    // HTTP origins the Clipboard API is unavailable, so the system menu is the
    // only way to paste on phones.
    const target = event.target;
    if (
      typeof target?.closest === "function" &&
      target.closest(".herdr-tty-paste-input")
    ) {
      return;
    }
    event.preventDefault();
  });

  if (!(navigator.maxTouchPoints > 0 || window.matchMedia("(pointer: coarse)").matches)) {
    return;
  }

  const holdDelay = 450;
  const compatibilityMouseDelay = 500;
  const dragThreshold = 6;
  const twoFingerTapDelay = 400;
  const twoFingerTapDistance = 12;

  function selectedTerminalText() {
    if (typeof window.term?.getSelection === "function") {
      const selection = window.term.getSelection();
      if (selection) return selection;
    }
    return document.getSelection?.()?.toString() || "";
  }

  function legacyCopyText(text) {
    const previousFocus = document.activeElement;
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("aria-hidden", "true");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "0";
    textarea.style.width = "1px";
    textarea.style.height = "1px";
    textarea.style.padding = "0";
    textarea.style.border = "0";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    let copied = false;
    textarea.addEventListener("copy", (event) => {
      if (!event.clipboardData) return;
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
      copied = true;
    });
    try {
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(0, textarea.value.length);
      copied = document.execCommand("copy") || copied;
    } finally {
      textarea.remove();
      if (previousFocus?.classList?.contains("xterm-helper-textarea")) {
        previousFocus.focus({ preventScroll: true });
      }
    }
    return copied;
  }

  function offerManualCopy(text) {
    if (typeof window.prompt !== "function") return false;
    window.prompt("Copy selected text", text);
    return true;
  }

  async function copyText(text) {
    if (!text) return false;
    if (window.isSecureContext && typeof navigator.clipboard?.writeText === "function") {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // LAN HTTP and browser permission policies can reject Clipboard API.
      }
    }
    return legacyCopyText(text) || offerManualCopy(text);
  }

  function createInputToolbar(terminal) {
    const toolbar = document.createElement("div");
    toolbar.className = "herdr-tty-input-toolbar";
    toolbar.hidden = false;
    toolbar.id = "touch-toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Terminal input controls");

    let suppressClickUntil = 0;
    let composing = false;
    const content = document.createElement("div");
    content.id = "panel-content";
    toolbar.appendChild(content);
    const composer = document.createElement("div");
    composer.id = "panel-composer";

    const reconnectIcon =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5"/><path d="M19 11a8 8 0 1 0 .4 5"/></svg>';

    function appendButton(parent, action, name) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = name;
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (performance.now() >= suppressClickUntil) void action();
      });
      parent.appendChild(button);
      return button;
    }

    const pasteInput = document.createElement("textarea");
    pasteInput.rows = 3;
    pasteInput.id = "panel-input";
    pasteInput.className = "herdr-tty-paste-input";
    pasteInput.placeholder = "输入…";
    pasteInput.setAttribute("aria-label", "Draft input");
    pasteInput.setAttribute("enterkeyhint", "enter");
    pasteInput.setAttribute("autocomplete", "off");
    pasteInput.setAttribute("autocapitalize", "off");
    pasteInput.setAttribute("autocorrect", "off");
    pasteInput.setAttribute("spellcheck", "false");
    composer.appendChild(pasteInput);
    const draftStorageKey = "herdr-tty-draft";
    try {
      pasteInput.value = window.sessionStorage.getItem(draftStorageKey) || "";
      window.sessionStorage.removeItem(draftStorageKey);
    } catch { /* Storage can be unavailable in a restricted browser context. */ }
    function saveDraft() {
      try { window.sessionStorage.setItem(draftStorageKey, pasteInput.value); } catch { /* Keep the in-page draft. */ }
    }
    pasteInput.addEventListener("compositionstart", () => { composing = true; });
    pasteInput.addEventListener("compositionend", () => { composing = false; });

    function sendDraft() {
      if (composing || updateConnectionState() !== "connected" || pasteInput.value === "") return;
      window.term.paste(pasteInput.value);
      pasteInput.value = "";
    }

    function pressEnter() {
      if (composing) return;
      const state = updateConnectionState();
      if (state === "reconnect-required") reconnectTerminal();
      else if (state === "connected") window.term.input("\r", true);
    }

    const actions = document.createElement("div");
    actions.className = "herdr-tty-toolbar-actions";
    actions.id = "panel-actions";
    const arrow = (direction) => window.term.input(
      "\x1b" + (window.term.modes.applicationCursorKeysMode ? "O" : "[") + direction, true,
    );
    const shortcuts = [
      ["up", "↑", "Arrow Up", () => arrow("A")],
      ["down", "↓", "Arrow Down", () => arrow("B")],
      ["right", "→", "Arrow Right", () => arrow("C")],
      ["clear", "Clear", "Clear", () => window.term.input("\x0c", true)],
      ["interrupt", "Ctrl+C", "Ctrl+C", () => window.term.input("\x03", true)],
    ];
    const shortcutButtons = shortcuts.map(([name, label, title, action]) => {
      const button = appendButton(actions, () => {
        if (updateConnectionState() === "connected") action();
      }, name);
      button.id = `${name}-button`;
      button.textContent = label;
      button.setAttribute("aria-label", title);
      return button;
    });
    const escapeButton = appendButton(
      actions,
      () => {
        if (updateConnectionState() === "connected") window.term.input("\x1b", true);
      },
      "escape",
    );
    const submitActions = document.createElement("div");
    submitActions.id = "panel-submit-actions";
    const sendButton = appendButton(submitActions, sendDraft, "send");
    sendButton.id = "send-button";
    sendButton.textContent = "Send";
    sendButton.setAttribute("aria-label", "Send");
    sendButton.setAttribute("title", "Paste draft without pressing Enter");
    const inputButton = appendButton(submitActions, pressEnter, "input");
    inputButton.id = "enter-button";
    composer.appendChild(submitActions);
    content.appendChild(actions);
    content.appendChild(composer);
    document.body.appendChild(toolbar);

    let x, y, drag = null;
    function viewBounds() {
      return {
        left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
        width: viewport?.width ?? window.innerWidth,
        height: viewport?.height ?? window.innerHeight,
      };
    }
    function placePanel() {
      const view = viewBounds();
      const right = view.left + view.width - toolbar.offsetWidth;
      // Keep the terminal's last input/status rows clear of the floating panel.
      const bottom = view.top + view.height - toolbar.offsetHeight - 72;
      x = Math.max(view.left, Math.min(x ?? right - 12, right));
      y = Math.max(view.top + 12, Math.min(y ?? view.top + 12, bottom));
      toolbar.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }
    toolbar.addEventListener("pointerdown", (event) => {
      if (event.target === pasteInput || event.button !== 0) return;
      event.preventDefault();
      drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY,
        x, y, moved: false };
    });
    toolbar.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      if (!drag.moved) {
        drag.moved = true;
        toolbar.setPointerCapture(event.pointerId);
        suppressClickUntil = Infinity;
      }
      x = drag.x + dx;
      y = drag.y + dy;
      placePanel();
    });
    function finishDrag(event) {
      if (!drag || event.pointerId !== drag.id) return;
      if (drag.moved) {
        suppressClickUntil = performance.now() + 300;
      }
      drag = null;
    }
    toolbar.addEventListener("pointerup", finishDrag);
    toolbar.addEventListener("pointercancel", finishDrag);
    toolbar.addEventListener("lostpointercapture", (event) => {
      // Touch starts with implicit capture on the button. Moving capture to
      // the toolbar must not end the drag when that button releases it.
      if (event.target === toolbar) finishDrag(event);
    });
    viewport?.addEventListener("resize", placePanel, { passive: true });
    viewport?.addEventListener("scroll", placePanel, { passive: true });
    window.addEventListener("resize", placePanel, { passive: true });
    placePanel();

    let connectionState = "connected";
    let reconnectTimer = 0;
    let reconnectStartedAt = 0;
    let checkingConnection = false;

    function scheduleReconnect() {
      clearTimeout(reconnectTimer);
      if (connectionState !== "connected") {
        reconnectTimer = window.setTimeout(recoverConnection, 2000);
      }
    }

    async function recoverConnection() {
      if (checkingConnection || document.hidden || connectionState === "connected") return;
      checkingConnection = true;
      try {
        // A socket retry cannot renew an expired login. Check the gateway first.
        const response = await fetch("/token", { cache: "no-store", signal: AbortSignal.timeout(5000) });
        if (response.redirected && new URL(response.url).pathname === "/_herdr/login") {
          saveDraft();
          window.location.assign("/_herdr/login");
          return;
        }
        if (!response.ok) return;
        if (connectionState === "reconnect-required") reconnectTerminal();
        else if (performance.now() - reconnectStartedAt > 8000) {
          // ttyd can stall mid-reconnect after a suspended mobile tab resumes.
          saveDraft();
          window.location.reload();
        }
      } catch { /* Stay on the terminal while the network is unavailable. */ }
      finally {
        checkingConnection = false;
        scheduleReconnect();
      }
    }
    window.addEventListener("online", () => { void recoverConnection(); });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) void recoverConnection();
    });

    function overlayConnectionState() {
      for (const child of terminal.children) {
        const message = child.textContent?.trim() || "";
        if (/^Reconnecting(?:\.\.\.)?$/i.test(message)) return "reconnecting";
        if (
          message === "Connection Closed" ||
          /^Press\s+.+\s+to\s+Reconnect$/i.test(message)
        ) {
          return "reconnect-required";
        }
      }
      return "connected";
    }

    function renderConnectionState(state) {
      if (state === "reconnecting" && connectionState !== state) reconnectStartedAt = performance.now();
      connectionState = state;
      scheduleReconnect();
      toolbar.dataset.connectionState = state;
      for (const button of [...shortcutButtons, escapeButton, sendButton]) button.disabled = state !== "connected";
      inputButton.disabled = state === "reconnecting";

      escapeButton.innerHTML = "";
      escapeButton.textContent = "Esc";
      escapeButton.setAttribute("aria-label", "Escape");
      escapeButton.setAttribute("title", "Escape");
      if (state === "reconnect-required" || state === "reconnecting") {
        inputButton.innerHTML = reconnectIcon;
        inputButton.setAttribute(
          "aria-label",
          state === "reconnecting" ? "Reconnecting" : "Reconnect",
        );
        inputButton.setAttribute(
          "title",
          state === "reconnecting" ? "Reconnecting" : "Reconnect",
        );
      } else {
        inputButton.innerHTML = "";
        inputButton.textContent = "Enter ↵";
        inputButton.setAttribute("aria-label", "Enter");
        inputButton.setAttribute("title", "Enter");
      }
      placePanel();
    }

    function updateConnectionState() {
      const state = overlayConnectionState();
      if (state !== connectionState) renderConnectionState(state);
      return state;
    }

    function reconnectTerminal() {
      const helper = terminal.querySelector?.(".xterm-helper-textarea");
      if (!helper) return;
      renderConnectionState("reconnecting");
      helper.focus({ preventScroll: true });
      helper.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code: "Enter",
          key: "Enter",
          keyCode: 13,
          which: 13,
        }),
      );
    }

    document.addEventListener(
      "click",
      (event) => {
        if (event.target === pasteInput || connectionState === "reconnecting") return;
        if (updateConnectionState() !== "reconnect-required") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        reconnectTerminal();
      },
      { capture: true },
    );

    renderConnectionState(overlayConnectionState());
    new MutationObserver(updateConnectionState).observe(terminal, {
      characterData: true,
      childList: true,
      subtree: true,
    });

    function herdrTextDialogVisible() {
      const activeBuffer = window.term?.buffer?.active;
      if (!activeBuffer || activeBuffer.type !== "alternate") return false;

      let titleRow = -1;
      let actionRow = -1;
      let paintedCaretRow = -1;
      const firstRow = activeBuffer.viewportY || 0;
      const rowCount = Number(window.term?.rows) || activeBuffer.length || 0;
      const lastRow = Math.min(activeBuffer.length || 0, firstRow + rowCount);
      const cursorRow = (activeBuffer.baseY || 0) + (activeBuffer.cursorY || 0);
      for (let row = firstRow; row < lastRow; row += 1) {
        const text = activeBuffer.getLine(row)?.translateToString(true) || "";
        const modalRow = text.indexOf("│") !== text.lastIndexOf("│");
        if (
          modalRow &&
          /\b(?:new workspace|rename workspace|new tab|rename tab|rename pane|new worktree)\b/i.test(
            text,
          )
        ) {
          titleRow = row;
        }
        if (modalRow && text.includes("█")) paintedCaretRow = row;
        if (
          modalRow &&
          (/\bsave\b.*\bclear\b.*\bcancel\b/i.test(text) ||
            /\bcreate and open\b.*\bcancel\b/i.test(text))
        ) {
          actionRow = row;
        }
      }
      if (titleRow < firstRow || actionRow <= titleRow) return false;

      // Herdr 0.8.0 paints a block caret into the input field. Newer builds
      // expose a real terminal cursor there for IME anchoring. Support both.
      return (
        (paintedCaretRow > titleRow && paintedCaretRow < actionRow) ||
        (cursorRow > titleRow && cursorRow < actionRow)
      );
    }

    let textDialogVisible = false;
    function focusComposerForHerdrDialog() {
      const visible = herdrTextDialogVisible();
      if (visible && !textDialogVisible && document.activeElement !== pasteInput) {
        placePanel();
        pasteInput.focus({ preventScroll: true });
      }
      textDialogVisible = visible;
    }

    if (typeof window.term?.onWriteParsed === "function") {
      window.term.onWriteParsed(focusComposerForHerdrDialog);
    } else if (typeof window.term?.onRender === "function") {
      window.term.onRender(focusComposerForHerdrDialog);
    }
    window.setTimeout(focusComposerForHerdrDialog, 0);

  }

  function attachTouchControls(terminal) {
    if (terminal.dataset.herdrWebTouch === "ready") return;
    terminal.dataset.herdrWebTouch = "ready";
    // ttyd applies its font preferences after opening the terminal. Settle the
    // initial grid after those preferences arrive.
    for (const delay of [80, 250, 500]) {
      window.setTimeout(() => window.term?.fit?.(), delay);
    }

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "herdr-tty-copy-button";
    copyButton.textContent = "Copy";
    copyButton.hidden = true;
    copyButton.setAttribute("aria-label", "Copy terminal selection");
    terminal.appendChild(copyButton);

    let copySelectionText = "";
    function captureCopySelection() {
      const text = selectedTerminalText();
      if (text) copySelectionText = text;
      return text;
    }

    for (const eventName of ["touchstart", "touchmove", "touchend", "touchcancel", "pointerdown", "mousedown"]) {
      copyButton.addEventListener(eventName, (event) => {
        if (eventName === "touchstart" || eventName === "pointerdown" || eventName === "mousedown") {
          captureCopySelection();
        }
        event.stopPropagation();
      });
    }
    copyButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const text = copySelectionText || captureCopySelection();
      if (!text) {
        copyButton.textContent = "No selection";
        return;
      }
      copyButton.disabled = true;
      void copyText(text).then((copied) => {
        copyButton.disabled = false;
        copyButton.textContent = copied ? "Copy" : "Copy unavailable";
        copyButton.hidden = copied;
        if (copied) copySelectionText = "";
      });
    });
    window.term?.onSelectionChange?.(captureCopySelection);

    createInputToolbar(terminal);

    let startX = 0;
    let startY = 0;
    let lastY = 0;
    let lastX = 0;
    let lastTime = 0;
    let velocity = 0;
    let dragging = false;
    let animation = 0;
    let holdTimer = 0;
    let activeTouches = 0;
    let selecting = false;
    let selectionMoved = false;
    let twoFinger = false;
    let twoFingerEligible = false;
    let twoFingerSent = false;
    let twoFingerStartTime = 0;
    let twoFingerStartX = 0;
    let twoFingerStartY = 0;
    let twoFingerX = 0;
    let twoFingerY = 0;
    let twoFingerMovement = 0;
    const terminalInput = terminal.querySelector?.(".xterm-helper-textarea");
    let terminalInputReadOnlyBeforeTouch = null;
    let terminalInputRestoreTimer = 0;

    function guardTerminalInputFromMouseTap() {
      if (!terminalInput) return;
      if (terminalInputRestoreTimer) clearTimeout(terminalInputRestoreTimer);
      terminalInputRestoreTimer = 0;
      if (terminalInputReadOnlyBeforeTouch === null) {
        terminalInputReadOnlyBeforeTouch = terminalInput.readOnly;
      }
      // xterm focuses this textarea before forwarding a mouse report. Keeping
      // it read-only for the touch gesture prevents a TUI click from opening
      // the virtual keyboard without interfering with the mouse report.
      terminalInput.readOnly = true;
    }

    function releaseTerminalInputGuard(delay) {
      if (terminalInputReadOnlyBeforeTouch === null) return;
      if (terminalInputRestoreTimer) clearTimeout(terminalInputRestoreTimer);
      terminalInputRestoreTimer = window.setTimeout(() => {
        terminalInputRestoreTimer = 0;
        if (activeTouches !== 0 || terminalInputReadOnlyBeforeTouch === null) return;
        terminalInput.readOnly = terminalInputReadOnlyBeforeTouch;
        terminalInputReadOnlyBeforeTouch = null;
      }, delay);
    }

    document.addEventListener(
      "mousedown",
      (event) => {
        if (
          terminalInputReadOnlyBeforeTouch === null ||
          !terminal.contains(event.target)
        ) {
          return;
        }
        // Compatibility mouse events may arrive in a later task than
        // touchend. Keep the input guarded through xterm's mousedown handler,
        // then restore it after the mouse report has been forwarded.
        guardTerminalInputFromMouseTap();
        releaseTerminalInputGuard(0);
      },
      { capture: true },
    );

    function stopInertia() {
      if (animation) cancelAnimationFrame(animation);
      animation = 0;
      velocity = 0;
    }

    function cancelHold() {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = 0;
    }

    function mouseTarget(clientX, clientY) {
      const target = document.elementFromPoint(clientX, clientY);
      return target && terminal.contains(target) ? target : terminal;
    }

    function sendMouse(type, clientX, clientY, button, buttons, forceSelection = false) {
      mouseTarget(clientX, clientY).dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          button,
          buttons,
          detail: type === "mousedown" ? 1 : 0,
          shiftKey: forceSelection,
          view: window,
        }),
      );
    }

    function beginSelection() {
      holdTimer = 0;
      if (activeTouches !== 1 || dragging || twoFinger) return;
      copySelectionText = "";
      selecting = true;
      selectionMoved = false;
      sendMouse("mousedown", startX, startY, 0, 1, true);
    }

    function finishSelection(clientX, clientY) {
      sendMouse("mouseup", clientX, clientY, 0, 0, true);
      selecting = false;
      captureCopySelection();
      if (selectionMoved) copyButton.hidden = false;
    }

    function touchCenter(touches) {
      return {
        x: (touches[0].clientX + touches[1].clientX) / 2,
        y: (touches[0].clientY + touches[1].clientY) / 2,
      };
    }

    function startTwoFingerTap(event) {
      cancelHold();
      stopInertia();
      if (selecting) finishSelection(lastX, lastY);
      dragging = false;
      copyButton.hidden = true;
      const center = touchCenter(event.touches);
      twoFinger = true;
      twoFingerEligible = true;
      twoFingerSent = false;
      twoFingerStartTime = performance.now();
      twoFingerStartX = twoFingerX = center.x;
      twoFingerStartY = twoFingerY = center.y;
      twoFingerMovement = 0;
    }

    function sendRightClick() {
      sendMouse("mousedown", twoFingerX, twoFingerY, 2, 2);
      sendMouse("mouseup", twoFingerX, twoFingerY, 2, 0);
    }

    function sendWheel(deltaY, clientX, clientY) {
      terminal.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          deltaMode: 0,
          deltaY,
          view: window,
        }),
      );
    }

    terminal.addEventListener(
      "touchstart",
      (event) => {
        if (event.target === copyButton) return;
        activeTouches = event.touches.length;
        guardTerminalInputFromMouseTap();
        copyButton.hidden = true;
        if (event.touches.length === 2) {
          startTwoFingerTap(event);
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (event.touches.length !== 1) {
          cancelHold();
          twoFingerEligible = false;
          return;
        }
        stopInertia();
        const touch = event.touches[0];
        startX = lastX = touch.clientX;
        startY = lastY = touch.clientY;
        lastTime = performance.now();
        dragging = false;
        selectionMoved = false;
        cancelHold();
        holdTimer = window.setTimeout(beginSelection, holdDelay);
      },
      { capture: true, passive: false },
    );

    terminal.addEventListener(
      "touchmove",
      (event) => {
        if (event.target === copyButton) return;
        activeTouches = event.touches.length;
        if (twoFinger) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (event.touches.length !== 2) {
            twoFingerEligible = false;
            return;
          }
          const center = touchCenter(event.touches);
          twoFingerX = center.x;
          twoFingerY = center.y;
          twoFingerMovement = Math.max(
            twoFingerMovement,
            Math.hypot(center.x - twoFingerStartX, center.y - twoFingerStartY),
          );
          return;
        }
        if (event.touches.length !== 1) return;
        const touch = event.touches[0];
        if (selecting) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (Math.hypot(touch.clientX - startX, touch.clientY - startY) >= dragThreshold) {
            selectionMoved = true;
          }
          lastX = touch.clientX;
          lastY = touch.clientY;
          sendMouse("mousemove", lastX, lastY, 0, 1, true);
          captureCopySelection();
          return;
        }
        const now = performance.now();
        const deltaY = lastY - touch.clientY;
        if (!dragging && Math.hypot(touch.clientX - startX, touch.clientY - startY) < dragThreshold) {
          return;
        }

        dragging = true;
        cancelHold();
        event.preventDefault();
        event.stopImmediatePropagation();
        sendWheel(deltaY, touch.clientX, touch.clientY);

        const elapsed = Math.max(1, now - lastTime);
        const frameVelocity = (deltaY / elapsed) * 16.67;
        velocity = velocity * 0.65 + frameVelocity * 0.35;
        lastY = touch.clientY;
        lastX = touch.clientX;
        lastTime = now;
      },
      { capture: true, passive: false },
    );

    terminal.addEventListener(
      "touchend",
      (event) => {
        if (event.target === copyButton) return;
        activeTouches = event.touches.length;
        if (activeTouches === 0) releaseTerminalInputGuard(compatibilityMouseDelay);
        if (twoFinger) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (!twoFingerSent && event.touches.length < 2) {
            const elapsed = performance.now() - twoFingerStartTime;
            if (twoFingerEligible && elapsed <= twoFingerTapDelay && twoFingerMovement <= twoFingerTapDistance) {
              sendRightClick();
            }
            twoFingerSent = true;
          }
          if (event.touches.length === 0) {
            twoFinger = false;
            twoFingerEligible = false;
          }
          return;
        }
        cancelHold();
        if (selecting) {
          event.preventDefault();
          event.stopImmediatePropagation();
          const touch = event.changedTouches[0];
          finishSelection(touch ? touch.clientX : lastX, touch ? touch.clientY : lastY);
          return;
        }
        if (!dragging || Math.abs(velocity) < 0.35) return;
        const glide = () => {
          velocity *= 0.92;
          if (Math.abs(velocity) < 0.35) {
            animation = 0;
            return;
          }
          sendWheel(velocity, lastX, lastY);
          animation = requestAnimationFrame(glide);
        };
        animation = requestAnimationFrame(glide);
      },
      { capture: true, passive: false },
    );

    terminal.addEventListener(
      "touchcancel",
      (event) => {
        if (event.target === copyButton) return;
        cancelHold();
        stopInertia();
        activeTouches = 0;
        releaseTerminalInputGuard(0);
        twoFinger = false;
        twoFingerEligible = false;
        if (selecting) {
          const touch = event.changedTouches[0];
          finishSelection(touch ? touch.clientX : lastX, touch ? touch.clientY : lastY);
        }
      },
      { capture: true, passive: true },
    );
  }

  function findTerminal() {
    const terminal = document.querySelector(".xterm");
    if (!terminal) return false;
    attachTouchControls(terminal);
    return true;
  }

  if (!findTerminal()) {
    const observer = new MutationObserver(() => {
      if (findTerminal()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();
