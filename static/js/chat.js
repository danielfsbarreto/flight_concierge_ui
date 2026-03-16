(function () {
  "use strict";

  // DOM refs
  const chatArea = document.getElementById("chatArea");
  const inputForm = document.getElementById("inputForm");
  const messageInput = document.getElementById("messageInput");
  const btnSend = document.getElementById("btnSend");
  const feedbackBar = document.getElementById("feedbackBar");
  const feedbackPrompt = document.getElementById("feedbackPrompt");
  const feedbackInput = document.getElementById("feedbackInput");
  const btnApprove = document.getElementById("btnApprove");
  const btnChange = document.getElementById("btnChange");

  let flowId = null;
  let eventSource = null;
  let renderedCount = 0;
  let lastStatus = null;
  let animating = 0;
  let lastKeepProcessing = false;
  let conversationEnded = false;
  const deferredActions = [];

  // ── Helpers ────────────────────────────────

  function scrollToBottom() {
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  function addBubble(role, content) {
    const div = document.createElement("div");
    div.className = role === "user" ? "bubble bubble-user" : "bubble bubble-assistant";
    if (role === "user") {
      div.textContent = content;
      chatArea.appendChild(div);
      scrollToBottom();
    } else {
      div.innerHTML = DOMPurify.sanitize(marked.parse(content));
      chatArea.appendChild(div);
      typewriterReveal(div);
    }
  }

  function typewriterReveal(element) {
    const entries = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let totalChars = 0;

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const full = node.textContent;
      if (!full.trim()) continue;
      if (node.parentElement.closest("table")) continue;
      entries.push({ node, full });
      totalChars += full.length;
      node.textContent = "";
    }
    if (!totalChars) return;

    animating++;
    setInputEnabled(false);
    hideTyping();

    const pending = new Set();
    element.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, table, hr")
      .forEach(el => { el.classList.add("tw-pending"); pending.add(el); });

    let idx = 0;
    let pos = 0;

    function revealUpTo(node) {
      const toReveal = [];
      for (const el of pending) {
        const cmp = node.compareDocumentPosition(el);
        if (cmp & (Node.DOCUMENT_POSITION_PRECEDING | Node.DOCUMENT_POSITION_CONTAINS)) {
          toReveal.push(el);
        }
      }
      for (const el of toReveal) {
        el.classList.remove("tw-pending");
        pending.delete(el);
      }
    }

    function revealAll() {
      for (const el of pending) el.classList.remove("tw-pending");
      pending.clear();
    }

    function tick() {
      if (idx >= entries.length) {
        revealAll();
        animating--;
        if (animating === 0) {
          flushDeferred();
          if (isFeedbackVisible()) {
            // Feedback bar took over — don't show typing or re-enable input
          } else if (lastKeepProcessing) {
            showTyping();
          } else {
            setInputEnabled(true);
          }
        }
        return;
      }
      const { node, full } = entries[idx];
      if (pos === 0) revealUpTo(node);
      const burst = 1 + Math.floor(Math.random() * 4);
      const end = Math.min(pos + burst, full.length);
      node.textContent = full.slice(0, end);
      pos = end;
      if (pos >= full.length) { idx++; pos = 0; }
      scrollToBottom();
      const delay = 10 + Math.floor(Math.random() * 30);
      requestAnimationFrame(() => setTimeout(tick, delay));
    }
    tick();
  }

  function runAfterAnimations(fn) {
    if (animating === 0) {
      fn();
    } else {
      deferredActions.push(fn);
    }
  }

  function flushDeferred() {
    while (deferredActions.length) {
      deferredActions.shift()();
    }
  }

  function removeWelcome() {
    const w = chatArea.querySelector(".welcome");
    if (w) w.remove();
  }

  function showTyping() {
    if (animating > 0) return;
    setInputEnabled(false);
    if (chatArea.querySelector(".typing")) return;
    const el = document.createElement("div");
    el.className = "typing";
    el.innerHTML = "<span></span><span></span><span></span>";
    chatArea.appendChild(el);
    scrollToBottom();
  }

  function isFeedbackVisible() {
    return feedbackBar.classList.contains("visible");
  }

  function hideTyping() {
    const el = chatArea.querySelector(".typing");
    if (el) {
      el.remove();
      if (animating === 0 && !isFeedbackVisible()) setInputEnabled(true);
    }
  }

  function setInputEnabled(enabled) {
    if (conversationEnded) enabled = false;
    messageInput.disabled = !enabled;
    btnSend.disabled = !enabled;
  }

  function showFeedback(pending) {
    feedbackPrompt.textContent = pending.message || "Please review the information above.";
    feedbackInput.value = "";
    feedbackBar.classList.add("visible");
    setInputEnabled(false);
    feedbackInput.focus();
  }

  function hideFeedback() {
    feedbackBar.classList.remove("visible");
    if (animating === 0 && !chatArea.querySelector(".typing")) {
      setInputEnabled(true);
      messageInput.focus();
    }
  }

  // ── Error modal ─────────────────────────────
  const errorModal = document.getElementById("errorModal");
  const errorModalText = document.getElementById("errorModalText");
  const errorModalBtn = document.getElementById("errorModalBtn");

  function showError(msg) {
    errorModalText.textContent = msg;
    errorModal.classList.add("visible");
    document.body.classList.add("modal-open");
    setInputEnabled(false);
  }

  errorModalBtn.addEventListener("click", () => {
    location.reload();
  });

  // ── Warm up the CrewAI Enterprise deployment ─
  const warmupOverlay = document.getElementById("warmupOverlay");

  function hideWarmupOverlay() {
    warmupOverlay.classList.add("hidden");
    warmupOverlay.addEventListener("transitionend", () => warmupOverlay.remove(), { once: true });
  }

  fetch("/api/warmup", { method: "POST" })
    .then(r => { if (!r.ok) throw new Error(r.status); hideWarmupOverlay(); })
    .catch(() => {
      hideWarmupOverlay();
      showError("Could not reach the flight concierge service");
    });

  // ── API calls ──────────────────────────────

  async function startConversation(text) {
    const resp = await fetch("/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    return resp.json();
  }

  async function submitFeedback(text) {
    const resp = await fetch(`/api/feedback/${flowId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback: text }),
    });
    return resp.json();
  }

  // ── SSE stream ─────────────────────────────

  function startStream() {
    stopStream();
    eventSource = new EventSource(`/api/stream/${flowId}`);

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      const messages = data.messages || [];

      if (messages.length > renderedCount) {
        hideTyping();
      }
      for (let i = renderedCount; i < messages.length; i++) {
        const msg = messages[i];
        if (i === 0 && msg.role === "user") {
          renderedCount++;
          continue;
        }
        addBubble(msg.role, msg.content);
        renderedCount++;
      }

      if (data.status === "waiting_for_feedback" && lastStatus !== "waiting_for_feedback") {
        if (data.pending_feedback) {
          const fb = data.pending_feedback;
          runAfterAnimations(() => showFeedback(fb));
        }
      } else if (data.status === "processing" && lastStatus !== "processing") {
        hideFeedback();
      }

      lastKeepProcessing = !!data.keep_processing;
      if (data.status === "waiting_for_feedback") {
        hideTyping();
      } else if (lastKeepProcessing) {
        showTyping();
      } else {
        hideTyping();
      }

      if (data.end_of_conversation && !chatArea.querySelector(".conversation-end")) {
        runAfterAnimations(() => {
          hideTyping();
          stopStream();
          conversationEnded = true;
          const divider = document.createElement("div");
          divider.className = "conversation-end";
          divider.textContent = "This conversation is over";
          chatArea.appendChild(divider);
          scrollToBottom();
          setInputEnabled(false);
          messageInput.placeholder = "";
        });
      }

      lastStatus = data.status;
    };
  }

  function stopStream() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  }

  // ── Event handlers ─────────────────────────

  inputForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = messageInput.value.trim();
    if (!text) return;

    messageInput.value = "";
    removeWelcome();
    addBubble("user", text);

    if (!flowId) {
      setInputEnabled(false);
      showTyping();
      try {
        const data = await startConversation(text);
        flowId = data.kickoff_id;
        renderedCount = 1;
        startStream();
      } catch (err) {
        hideTyping();
        addBubble("assistant", "Sorry, something went wrong starting the conversation. Please try again.");
        setInputEnabled(true);
      }
    }
  });

  btnApprove.addEventListener("click", async () => {
    const extra = feedbackInput.value.trim();
    const text = extra || "Approved. Looks good!";
    hideFeedback();
    addBubble("user", text);
    showTyping();
    renderedCount++;
    try {
      await submitFeedback(text);
    } catch {
      hideTyping();
      addBubble("assistant", "Failed to submit feedback. Please try again.");
    }
  });

  feedbackInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (feedbackInput.value.trim()) {
        btnChange.click();
      } else {
        btnApprove.click();
      }
    }
  });

  btnChange.addEventListener("click", async () => {
    const text = feedbackInput.value.trim();
    if (!text) {
      feedbackInput.focus();
      feedbackInput.placeholder = "Please describe what you'd like to change...";
      return;
    }
    hideFeedback();
    addBubble("user", text);
    showTyping();
    renderedCount++;
    try {
      await submitFeedback(text);
    } catch {
      hideTyping();
      addBubble("assistant", "Failed to submit feedback. Please try again.");
    }
  });
})();
