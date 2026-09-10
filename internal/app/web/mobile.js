(() => {
  "use strict";

  const root = document.documentElement;
  const viewport = window.visualViewport;
  const isIOS =
    /\b(iPad|iPhone|iPod)\b/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isIPad =
    /\biPad\b/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isIPadChrome = /\bCriOS\//.test(navigator.userAgent) && isIPad;
  let lastViewportMetrics = "";
  let viewportFrame = 0;
  let viewportTimers = [];
  let dispatchingResize = false;

  function notifyTerminalResize() {
    if (
      document.querySelector(".xterm") &&
      typeof window.term?.fit === "function"
    ) {
      window.term.fit();
      return;
    }
    dispatchingResize = true;
    window.dispatchEvent(new Event("resize"));
    dispatchingResize = false;
  }

  function updateViewport(forceFit = false) {
    const layoutHeight = window.innerHeight;
    const visualHeight = viewport ? viewport.height : layoutHeight;
    // Ignore iPad Chrome's small stale focus inset after the keyboard closes,
    // while retaining the smaller visual viewport when a keyboard is visible.
    const useLayoutViewport =
      !viewport ||
      (isIPadChrome &&
        layoutHeight > visualHeight &&
        layoutHeight - visualHeight < layoutHeight / 4);
    const height = Math.ceil(useLayoutViewport ? layoutHeight : visualHeight);
    const width = Math.ceil(useLayoutViewport || !viewport ? window.innerWidth : viewport.width);
    const top = Math.round(
      viewport && !useLayoutViewport
        ? Math.max(viewport.offsetTop, viewport.pageTop - window.scrollY, 0)
        : 0,
    );
    const left = Math.round(
      viewport && !useLayoutViewport
        ? Math.max(viewport.offsetLeft, viewport.pageLeft - window.scrollX, 0)
        : 0,
    );
    const metrics = `${width}:${height}:${left}:${top}`;
    if (metrics !== lastViewportMetrics) {
      lastViewportMetrics = metrics;
      root.style.setProperty("--herdr-tty-viewport-height", `${height}px`);
      root.style.setProperty("--herdr-tty-viewport-width", `${width}px`);
      root.style.setProperty("--herdr-tty-viewport-top", `${top}px`);
      root.style.setProperty("--herdr-tty-viewport-left", `${left}px`);
      forceFit = true;
    }
    if (forceFit) notifyTerminalResize();
  }

  function scheduleViewportUpdate() {
    if (viewportFrame) cancelAnimationFrame(viewportFrame);
    viewportFrame = requestAnimationFrame(() => {
      viewportFrame = 0;
      updateViewport(true);
    });
    for (const timer of viewportTimers) clearTimeout(timer);
    viewportTimers = [80, 250, 500].map((delay) =>
      window.setTimeout(() => updateViewport(true), delay),
    );
  }

  if (viewport) {
    viewport.addEventListener("resize", scheduleViewportUpdate, { passive: true });
    viewport.addEventListener("scroll", scheduleViewportUpdate, { passive: true });
    viewport.addEventListener("scrollend", scheduleViewportUpdate, { passive: true });
  }
  window.addEventListener(
    "resize",
    () => {
      if (!dispatchingResize) scheduleViewportUpdate();
    },
    { passive: true },
  );
  window.addEventListener("orientationchange", scheduleViewportUpdate, { passive: true });
  document.addEventListener("focusin", scheduleViewportUpdate, { passive: true });
  document.addEventListener("focusout", scheduleViewportUpdate, { passive: true });
  updateViewport(true);

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
    let compositionEndedAt = -Infinity;
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

    const pasteInput = document.createElement("input");
    pasteInput.type = "text";
    pasteInput.id = "panel-input";
    pasteInput.className = "herdr-tty-paste-input";
    pasteInput.placeholder = "输入…";
    pasteInput.setAttribute("aria-label", "Draft input");
    pasteInput.setAttribute("enterkeyhint", "send");
    pasteInput.setAttribute("autocomplete", "off");
    pasteInput.setAttribute("autocapitalize", "off");
    pasteInput.setAttribute("autocorrect", "off");
    pasteInput.setAttribute("spellcheck", "false");
    composer.appendChild(pasteInput);
    pasteInput.addEventListener("compositionstart", () => { composing = true; });
    pasteInput.addEventListener("compositionend", () => {
      composing = false;
      compositionEndedAt = performance.now();
    });
    pasteInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing || event.keyCode === 229 || composing) return;
      event.preventDefault();
      // Safari may deliver the IME-confirming Enter just after compositionend.
      if (performance.now() - compositionEndedAt < 80) return;
      submitPasteInput();
    });

    function submitPasteInput() {
      if (composing || performance.now() < suppressClickUntil) return;
      const state = updateConnectionState();
      if (state === "reconnect-required") {
        reconnectTerminal();
        return;
      }
      if (state !== "connected") return;
      if (pasteInput.value !== "") {
        const text = pasteInput.value;
        window.term.paste(text);
        window.term.input("\r", true);
        pasteInput.value = "";
        return;
      }
      window.term.input("\r", true);
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
      ["bottom", "⤓", "Scroll to bottom", () => window.term.scrollToBottom()],
      ["clear", "Clear", "Clear", () => window.term.input("\x0c", true)],
      ["space", "Space", "Space", () => {
        if (document.activeElement === pasteInput) {
          pasteInput.setRangeText(" ", pasteInput.selectionStart, pasteInput.selectionEnd, "end");
        } else window.term.input(" ", true);
      }],
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
    const inputButton = appendButton(composer, submitPasteInput, "input");
    inputButton.id = "enter-button";
    content.appendChild(actions);
    content.appendChild(composer);
    const edgeTab = appendButton(toolbar, () => setDock(null), "expand");
    edgeTab.id = "edge-tab";
    edgeTab.setAttribute("aria-label", "Expand panel");
    edgeTab.setAttribute("aria-controls", "panel-content");
    document.body.appendChild(toolbar);

    let x, y, dockSide = null, drag = null;
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
      const bottom = view.top + view.height - toolbar.offsetHeight - 12;
      x = dockSide === "left" ? view.left : dockSide === "right" ? right
        : Math.max(view.left, Math.min(x ?? right - 12, right));
      y = Math.max(view.top + 12, Math.min(y ?? bottom, bottom));
      toolbar.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }
    function setDock(side) {
      dockSide = side;
      toolbar.dataset.side = side || "";
      edgeTab.textContent = side === "left" ? "›" : "‹";
      edgeTab.setAttribute("aria-expanded", String(!side));
      placePanel();
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
      dockSide = null;
      placePanel();
    });
    function finishDrag(event) {
      if (!drag || event.pointerId !== drag.id) return;
      if (drag.moved) {
        suppressClickUntil = performance.now() + 300;
        const view = viewBounds();
        const leftGap = x - view.left;
        const rightGap = view.left + view.width - x - toolbar.offsetWidth;
        setDock(Math.min(leftGap, rightGap) <= 24
          ? (leftGap < rightGap ? "left" : "right") : null);
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
    setDock(null);

    let connectionState = "connected";

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
      connectionState = state;
      toolbar.dataset.connectionState = state;
      for (const button of [...shortcutButtons, escapeButton]) button.disabled = state !== "connected";
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
        if (connectionState === "reconnecting") return;
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

    function setVisible(visible) {
      if (visible) setDock(null);
    }

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
        setVisible(true);
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

    return { show: () => setVisible(true) };
  }

  function attachTouchControls(terminal) {
    if (terminal.dataset.herdrWebTouch === "ready") return;
    terminal.dataset.herdrWebTouch = "ready";
    scheduleViewportUpdate();

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

    const inputToolbar = createInputToolbar(terminal);

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

    terminal.addEventListener("click", (event) => {
      if (event.target === copyButton) return;
      // A terminal tap can bring the docked input panel back into view.
      inputToolbar.show();
    });

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
