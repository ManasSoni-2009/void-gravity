// Custom Gemini API Key — sends Antigravity's chat through your own Google AI Studio keys.
//
// Supports multiple API keys with automatic failover rotation when daily quotas are reached,
// same-key cooldown on transient per-minute rate spikes, and seamless passthrough for
// Antigravity's default subscription models.

const READY = typeof plugin.gemini === "object" && plugin.gemini !== null;

const OFFLINE_STATUS = {
  phase: "off",
  keyed: false,
  trusted: false,
  restartRequired: true,
  counts: { translated: 0, passedThrough: 0, failed: 0 }
};

const gemini = READY
  ? plugin.gemini
  : {
      status: () => OFFLINE_STATUS,
      configure: async () => OFFLINE_STATUS,
      test: async () => ({ ok: false, message: "BetterGravity bridge is offline." }),
      onStatusChanged: () => () => {}
    };

// Inject custom styles for multi-key chips, badges, and management cards
plugin.styles.add(`
  .vg-key-container { display: flex; flex-direction: column; gap: 8px; width: 100%; margin-top: 6px; }
  .vg-chips-wrapper { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .vg-chip {
    display: inline-flex; align-items: center; gap: 6px;
    background: rgba(120, 120, 120, 0.12);
    border: 1px solid rgba(120, 120, 120, 0.25);
    border-radius: 6px; padding: 3px 8px;
    font-size: 11px; font-family: monospace;
    color: inherit;
  }
  .vg-chip-primary {
    border-color: rgba(59, 130, 246, 0.5);
    background: rgba(59, 130, 246, 0.12);
  }
  .vg-chip-tag {
    font-size: 9px; font-weight: 600; text-transform: uppercase;
    padding: 1px 4px; border-radius: 3px;
    background: rgba(120, 120, 120, 0.2);
  }
  .vg-chip-primary .vg-chip-tag {
    background: rgba(59, 130, 246, 0.3);
    color: #60a5fa;
  }
  .vg-chip-del {
    cursor: pointer; opacity: 0.6; display: inline-flex; align-items: center; justify-content: center;
    border: none; background: transparent; padding: 0; color: inherit;
    font-size: 12px; line-height: 1; margin-left: 2px;
  }
  .vg-chip-del:hover { opacity: 1; color: #ef4444; }
  .vg-add-btn-small {
    display: inline-flex; align-items: center; gap: 4px;
    background: transparent; border: 1px dashed rgba(120, 120, 120, 0.4);
    border-radius: 6px; padding: 3px 8px; font-size: 11px; cursor: pointer;
    color: inherit; opacity: 0.8;
  }
  .vg-add-btn-small:hover { opacity: 1; border-color: currentColor; background: rgba(120, 120, 120, 0.1); }
  .vg-card {
    border: 1px solid rgba(120, 120, 120, 0.2);
    border-radius: 8px; padding: 12px 14px;
    background: rgba(120, 120, 120, 0.05);
    display: flex; flex-direction: column; gap: 8px;
  }
  .vg-card-header { display: flex; justify-content: space-between; align-items: center; }
  .vg-card-title { font-size: 13px; font-weight: 600; }
  .vg-badge {
    font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 4px;
    background: rgba(34, 197, 94, 0.15); color: #22c55e;
  }
  .vg-badge-fallback {
    background: rgba(59, 130, 246, 0.15); color: #3b82f6;
  }
`);

// ---------------------------------------------------------------------------
// Multi-Key Storage and Synchronization
// ---------------------------------------------------------------------------

function parseKeyList(raw) {
  const keys = [];
  if (typeof raw === "string") {
    for (const item of raw.split(/[\r\n,;]+/)) {
      const s = item.trim();
      if ((s.startsWith("AIzaSy") || s.length > 20) && !keys.includes(s)) {
        keys.push(s);
      }
    }
  }
  return keys;
}

function getStoredKeys() {
  const keys = [];
  function add(k) {
    if (typeof k === "string") {
      for (const item of k.split(/[\r\n,;]+/)) {
        const s = item.trim();
        if ((s.startsWith("AIzaSy") || s.length > 20) && !keys.includes(s)) {
          keys.push(s);
        }
      }
    }
  }
  add(settings.apiKey);
  const extra = plugin.storage.get("extraKeys", []);
  if (Array.isArray(extra)) {
    extra.forEach(add);
  }
  return keys;
}

function saveStoredKeys(keys) {
  const joined = keys.join("\n");
  settings.apiKey = joined;
  plugin.settings.set("apiKey", joined);
  plugin.storage.set("extraKeys", keys.slice(1));
  void push();
}

function maskKey(k) {
  if (!k || typeof k !== "string") return "";
  if (k.length <= 12) return k;
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Settings Schema
// ---------------------------------------------------------------------------

const settings = plugin.settings.define({
  apiKey: {
    type: "string",
    label: "Gemini API key",
    description: "Your primary Google AI Studio key (aistudio.google.com/apikey). Click [+] beside the field or use the '+ Add Key' button below to configure fallback keys.",
    default: "",
    placeholder: "AIza…",
    secret: true
  },
  addKeyAction: {
    type: "action",
    label: "Add Fallback API Key (+)",
    description: "Add a fallback Gemini API key for automatic failover when daily quota is exhausted.",
    action: "+ Add Key",
    onSelect: () => {
      openAddKeyModal();
    }
  },
  keysPoolStatus: {
    type: "note",
    label: "Active Keys Pool",
    description: "Current configured Google AI Studio keys used for Gemini 4 models",
    read: () => {
      const keys = getStoredKeys();
      if (keys.length === 0) return "No keys configured (Chat stays on Antigravity subscription)";
      if (keys.length === 1) return `1 key active: ${maskKey(keys[0])} [Primary]`;
      return `${keys.length} keys active: ` + keys.map((k, i) => `#${i + 1} (${maskKey(k)})${i === 0 ? " [Primary]" : " [Fallback]"}`).join(", ");
    }
  },
  manageKeysAction: {
    type: "action",
    label: "Manage API Keys",
    description: "View, test connection, or remove configured keys.",
    action: "Manage Keys",
    onSelect: () => {
      openManageKeysModal();
    }
  },
  baseUrl: {
    type: "string",
    label: "Base URL",
    description:
      "Where the key is used. Leave it empty for Google's own API; set it only if you go through something else that speaks the same one.",
    default: "",
    placeholder: "https://generativelanguage.googleapis.com"
  },
  stream: {
    type: "boolean",
    label: "Stream replies",
    description: "Shows the answer as it is written, the way Antigravity does on its own credentials.",
    default: true
  },
  thoughts: {
    type: "boolean",
    label: "Show the model's thinking",
    description: "Passes thinking through to the interface instead of dropping it. Costs nothing extra; it is already generated.",
    default: true
  },
  audit: {
    type: "boolean",
    label: "Keep a request log",
    description: "One line per request under the BetterGravity folder: model, size, and outcome. Never the prompt, never the key.",
    default: false
  }
});

/** Hands the main process the keys and preferences */
function push() {
  return gemini.configure({
    apiKey: String(settings.apiKey || "").trim(),
    baseUrl: String(settings.baseUrl || "").trim(),
    stream: settings.stream !== false,
    thoughts: settings.thoughts !== false,
    audit: settings.audit === true
  });
}

// ---------------------------------------------------------------------------
// Modals: Add Key & Manage Keys
// ---------------------------------------------------------------------------

function openAddKeyModal(onComplete) {
  plugin.ui.modal({
    title: "Add Gemini API Key",
    description: "Enter an API key from Google AI Studio (aistudio.google.com/apikey). VoidGravity will automatically rotate to this fallback key when previous keys hit daily limits.",
    width: 480,
    render(body, close) {
      const input = plugin.ui.element("input", {
        type: "password",
        class: plugin.ui.classes.input,
        placeholder: "Paste Google AI Studio key (AIzaSy...)",
        autocomplete: "off",
        spellcheck: "false"
      });
      input.style.width = "100%";
      input.style.marginBottom = "8px";

      const errorMsg = plugin.ui.element("div", {
        class: "text-xs text-destructive",
        text: ""
      });
      errorMsg.style.display = "none";
      errorMsg.style.marginBottom = "10px";

      const showToggle = plugin.ui.element("label", {
        class: "text-xs text-muted-foreground flex items-center gap-1.5 cursor-pointer select-none",
        text: " Show key"
      });
      const check = plugin.ui.element("input", { type: "checkbox" });
      check.addEventListener("change", () => {
        input.type = check.checked ? "text" : "password";
      });
      showToggle.prepend(check);

      const cancelBtn = plugin.ui.element("button", {
        type: "button",
        class: plugin.ui.classes.button,
        text: "Cancel"
      });
      cancelBtn.addEventListener("click", close);

      const submitBtn = plugin.ui.element("button", {
        type: "button",
        class: plugin.ui.classes.button,
        text: "Add Key"
      });
      submitBtn.style.background = "var(--primary, #3b82f6)";
      submitBtn.style.color = "#ffffff";

      const submit = () => {
        const val = input.value.trim();
        if (!val || (!val.startsWith("AIzaSy") && val.length < 20)) {
          errorMsg.textContent = "Please enter a valid Google AI Studio key (typically starts with AIzaSy...).";
          errorMsg.style.display = "block";
          input.focus();
          return;
        }

        const currentKeys = getStoredKeys();
        if (currentKeys.includes(val)) {
          errorMsg.textContent = "This API key is already configured in your pool.";
          errorMsg.style.display = "block";
          input.focus();
          return;
        }

        currentKeys.push(val);
        saveStoredKeys(currentKeys);

        plugin.ui.toast({
          title: "Gemini Key Added",
          body: `Added key #${currentKeys.length} (${maskKey(val)}) to rotation pool.`,
          kind: "info"
        });

        close();
        onComplete?.();
      };

      submitBtn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        }
      });

      const buttons = plugin.ui.element("div", { class: "flex justify-end gap-2 mt-4" }, [cancelBtn, submitBtn]);

      body.append(
        plugin.ui.element("div", { class: "flex flex-col gap-2" }, [
          input,
          showToggle,
          errorMsg,
          buttons
        ])
      );

      queueMicrotask(() => input.focus());
    }
  });
}

function openManageKeysModal(onComplete) {
  plugin.ui.modal({
    title: "Manage Gemini API Keys",
    description: "Configured API keys for Gemini 4 models. Keys rotate in order upon daily quota exhaustion.",
    width: 520,
    render(body, close) {
      function refreshModal() {
        body.replaceChildren();
        const currentKeys = getStoredKeys();

        const listContainer = plugin.ui.element("div", { class: "flex flex-col gap-2.5 max-h-[380px] overflow-y-auto" });

        if (currentKeys.length === 0) {
          listContainer.append(
            plugin.ui.element("div", { class: "text-sm text-muted-foreground py-4 text-center" }, [
              "No custom API keys configured. Chat uses Antigravity's built-in subscription."
            ])
          );
        } else {
          currentKeys.forEach((key, index) => {
            const isPrimary = index === 0;
            const card = plugin.ui.element("div", { class: "vg-card" });

            const topRow = plugin.ui.element("div", { class: "vg-card-header" });
            const titleBlock = plugin.ui.element("div", { class: "flex items-center gap-2" });
            const badge = plugin.ui.element("span", {
              class: isPrimary ? "vg-badge" : "vg-badge vg-badge-fallback",
              text: isPrimary ? "Primary Key" : `Fallback Key #${index + 1}`
            });
            const keyText = plugin.ui.element("span", {
              class: "font-mono text-xs text-foreground",
              text: maskKey(key)
            });
            titleBlock.append(badge, keyText);

            const actions = plugin.ui.element("div", { class: "flex items-center gap-1.5" });

            const testBtn = plugin.ui.element("button", {
              type: "button",
              class: plugin.ui.classes.buttonQuiet,
              text: "Test",
              title: "Test API key quota & validity"
            });
            testBtn.style.fontSize = "11px";
            testBtn.style.padding = "2px 8px";
            testBtn.style.height = "auto";
            testBtn.style.width = "auto";

            const testResult = plugin.ui.element("span", { class: "text-xs text-muted-foreground", text: "" });

            testBtn.addEventListener("click", async () => {
              testBtn.disabled = true;
              testResult.textContent = "Testing…";
              try {
                const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
                if (res.ok) {
                  testResult.textContent = "✅ Valid & Active";
                  testResult.style.color = "#22c55e";
                } else {
                  const errData = await res.json().catch(() => ({}));
                  const errCode = errData?.error?.status || res.status;
                  testResult.textContent = `⚠️ Error: ${errCode}`;
                  testResult.style.color = "#ef4444";
                }
              } catch (e) {
                testResult.textContent = "❌ Connection failed";
                testResult.style.color = "#ef4444";
              } finally {
                testBtn.disabled = false;
              }
            });

            const delBtn = plugin.ui.element("button", {
              type: "button",
              class: plugin.ui.classes.buttonQuiet,
              "aria-label": `Remove key #${index + 1}`,
              title: "Remove this key"
            });
            delBtn.append(plugin.ui.icon(plugin.ui.icons.trash, 14));
            delBtn.addEventListener("click", () => {
              const updated = currentKeys.filter((_, i) => i !== index);
              saveStoredKeys(updated);
              plugin.ui.toast({
                title: "Key Removed",
                body: `Removed key #${index + 1} from rotation pool.`,
                kind: "info"
              });
              refreshModal();
              onComplete?.();
            });

            actions.append(testResult, testBtn, delBtn);
            topRow.append(titleBlock, actions);
            card.append(topRow);
            listContainer.append(card);
          });
        }

        const addBtn = plugin.ui.element("button", {
          type: "button",
          class: plugin.ui.classes.button,
          text: "+ Add Another Key"
        });
        addBtn.prepend(plugin.ui.icon(plugin.ui.icons.plus, 14));
        addBtn.addEventListener("click", () => {
          openAddKeyModal(() => {
            refreshModal();
            onComplete?.();
          });
        });

        const doneBtn = plugin.ui.element("button", {
          type: "button",
          class: plugin.ui.classes.button,
          text: "Done"
        });
        doneBtn.addEventListener("click", close);

        const footer = plugin.ui.element("div", { class: "flex justify-between items-center mt-4 pt-2 border-t border-border" }, [
          addBtn,
          doneBtn
        ]);

        body.append(listContainer, footer);
      }

      refreshModal();
    }
  });
}

// ---------------------------------------------------------------------------
// Dedicated Settings Sidebar Section: "Gemini Keys"
// ---------------------------------------------------------------------------

plugin.ui.settingsSection({
  label: "Gemini Keys",
  render(container) {
    function renderContent() {
      container.replaceChildren();

      const currentKeys = getStoredKeys();

      const page = plugin.ui.element("div", { class: "p-6 flex flex-col gap-6 w-full max-w-2xl mx-auto" });

      // Header
      const header = plugin.ui.element("div", { class: "flex flex-col gap-1" }, [
        plugin.ui.element("h2", { class: "m-0 text-xl font-semibold text-foreground", text: "Gemini 4 Keys & Automatic Quota Rotation" }),
        plugin.ui.element("p", {
          class: "text-sm text-muted-foreground",
          text: "Configure one or more Google AI Studio API keys. VoidGravity routes Gemini 4 models (Argon, Hydrogen, Neon, Carbon) through these keys, automatically failing over to the next key when daily/weekly quotas are reached."
        })
      ]);

      // Add Key Box
      const addGroup = plugin.ui.element("div", { class: "space-y-2" });
      addGroup.append(plugin.ui.element("h3", { class: "m-0 text-sm font-medium", text: "Add API Key" }));

      const addCard = plugin.ui.element("div", { class: "vg-card" });
      const addRow = plugin.ui.element("div", { class: "flex items-center gap-2" });

      const newKeyInput = plugin.ui.element("input", {
        type: "password",
        class: plugin.ui.classes.input,
        placeholder: "Paste Google AI Studio API key (AIzaSy...)"
      });
      newKeyInput.style.flex = "1";

      const addBtn = plugin.ui.element("button", {
        type: "button",
        class: plugin.ui.classes.button,
        text: "Add Key"
      });
      addBtn.style.background = "var(--primary, #3b82f6)";
      addBtn.style.color = "#ffffff";
      addBtn.prepend(plugin.ui.icon(plugin.ui.icons.plus, 14));

      const pasteBtn = plugin.ui.element("button", {
        type: "button",
        class: plugin.ui.classes.button,
        text: "Paste"
      });
      pasteBtn.addEventListener("click", async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text) newKeyInput.value = text.trim();
        } catch {}
      });

      const addAction = () => {
        const val = newKeyInput.value.trim();
        if (!val || (!val.startsWith("AIzaSy") && val.length < 20)) {
          plugin.ui.toast({
            title: "Invalid Key Format",
            body: "Google AI Studio keys typically begin with AIzaSy...",
            kind: "warning"
          });
          return;
        }
        if (currentKeys.includes(val)) {
          plugin.ui.toast({
            title: "Key Already Exists",
            body: "This key is already in your rotation pool.",
            kind: "warning"
          });
          return;
        }
        currentKeys.push(val);
        saveStoredKeys(currentKeys);
        plugin.ui.toast({
          title: "API Key Added",
          body: `Added key #${currentKeys.length} (${maskKey(val)}) to pool.`,
          kind: "info"
        });
        renderContent();
      };

      addBtn.addEventListener("click", addAction);
      newKeyInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          addAction();
        }
      });

      addRow.append(newKeyInput, pasteBtn, addBtn);
      addCard.append(addRow);
      addGroup.append(addCard);

      // Key List
      const listGroup = plugin.ui.element("div", { class: "space-y-2" });
      listGroup.append(
        plugin.ui.element("h3", {
          class: "m-0 text-sm font-medium",
          text: `Configured Key Pool (${currentKeys.length} Key${currentKeys.length === 1 ? "" : "s"})`
        })
      );

      const listCard = plugin.ui.element("div", { class: plugin.ui.classes.card });

      if (currentKeys.length === 0) {
        listCard.append(
          plugin.ui.element("div", { class: "p-4 text-center text-sm text-muted-foreground" }, [
            "No API keys configured yet. Chat will remain on Antigravity's built-in subscription."
          ])
        );
      } else {
        currentKeys.forEach((key, index) => {
          const isPrimary = index === 0;
          const row = plugin.ui.element("div", { class: plugin.ui.classes.row });

          const infoCol = plugin.ui.element("div", { class: "flex items-center gap-2.5" });
          const badge = plugin.ui.element("span", {
            class: isPrimary ? "vg-badge" : "vg-badge vg-badge-fallback",
            text: isPrimary ? "Key #1 (Primary)" : `Key #${index + 1} (Fallback)`
          });
          const keyMono = plugin.ui.element("span", {
            class: "font-mono text-xs text-foreground",
            text: maskKey(key)
          });
          infoCol.append(badge, keyMono);

          const ctrlCol = plugin.ui.element("div", { class: "flex items-center gap-2" });

          const testRes = plugin.ui.element("span", { class: "text-xs text-muted-foreground", text: "" });

          const testBtn = plugin.ui.element("button", {
            type: "button",
            class: plugin.ui.classes.button,
            text: "Test"
          });
          testBtn.style.height = "26px";
          testBtn.style.fontSize = "11px";
          testBtn.style.padding = "0 8px";

          testBtn.addEventListener("click", async () => {
            testBtn.disabled = true;
            testRes.textContent = "Testing…";
            try {
              const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
              if (res.ok) {
                testRes.textContent = "✅ Active (200 OK)";
                testRes.style.color = "#22c55e";
              } else {
                testRes.textContent = `⚠️ Code: ${res.status}`;
                testRes.style.color = "#ef4444";
              }
            } catch (err) {
              testRes.textContent = "❌ Network error";
              testRes.style.color = "#ef4444";
            } finally {
              testBtn.disabled = false;
            }
          });

          const delBtn = plugin.ui.element("button", {
            type: "button",
            class: plugin.ui.classes.buttonQuiet,
            "aria-label": "Delete key"
          });
          delBtn.append(plugin.ui.icon(plugin.ui.icons.trash, 14));
          delBtn.addEventListener("click", () => {
            const updated = currentKeys.filter((_, i) => i !== index);
            saveStoredKeys(updated);
            plugin.ui.toast({
              title: "Key Removed",
              body: `Removed key #${index + 1} from rotation pool.`,
              kind: "info"
            });
            renderContent();
          });

          ctrlCol.append(testRes, testBtn, delBtn);
          row.append(infoCol, ctrlCol);
          listCard.append(row);
        });
      }
      listGroup.append(listCard);

      // Quota & Rotation Explainer
      const infoGroup = plugin.ui.element("div", { class: "space-y-2 mt-2" });
      const infoCard = plugin.ui.element("div", { class: "vg-card text-xs text-muted-foreground leading-relaxed" });
      infoCard.innerHTML = `
        <div style="font-weight: 600; color: var(--foreground, #ffffff); margin-bottom: 4px;">⚡ How Quota Rotation Works in VoidGravity</div>
        <div><b>1. Transient TPM Bursts (429):</b> When you hit Google's per-minute token spike, VoidGravity pauses 15–25 seconds on the <i>same key</i> with cooldown. This prevents context loss and tool hallucinations.</div>
        <div><b>2. Daily/Weekly Quota Limits:</b> When a key's daily free-tier quota (250k input tokens/day) is exhausted, VoidGravity automatically advances to your next fallback key and notifies you in chat.</div>
        <div><b>3. Antigravity Built-in Models:</b> Standard models like <b>Gemini 3.8 Flash</b> and <b>Claude Sonnet</b> bypass translation and remain on Antigravity's subscription with zero quota limits.</div>
      `;
      infoGroup.append(infoCard);

      page.append(header, addGroup, listGroup, infoGroup);
      container.append(page);
    }

    renderContent();
  }
});

// ---------------------------------------------------------------------------
// DOM Observer: Inline "+" Icon and Key Chips in Settings Options
// ---------------------------------------------------------------------------

function updateChipsContainer(container) {
  if (!container) return;
  container.replaceChildren();

  const keys = getStoredKeys();
  const wrapper = plugin.ui.element("div", { class: "vg-chips-wrapper" });

  keys.forEach((key, index) => {
    const isPrimary = index === 0;
    const chip = plugin.ui.element("div", {
      class: isPrimary ? "vg-chip vg-chip-primary" : "vg-chip"
    });

    const tag = plugin.ui.element("span", {
      class: "vg-chip-tag",
      text: isPrimary ? "Key #1" : `Key #${index + 1}`
    });

    const keyText = plugin.ui.element("span", { text: maskKey(key) });

    chip.append(tag, keyText);

    if (!isPrimary) {
      const delBtn = plugin.ui.element("button", {
        type: "button",
        class: "vg-chip-del",
        title: "Remove fallback key",
        text: "✕"
      });
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const updated = keys.filter((_, i) => i !== index);
        saveStoredKeys(updated);
        updateChipsContainer(container);
      });
      chip.append(delBtn);
    }

    wrapper.append(chip);
  });

  const addSmall = plugin.ui.element("button", {
    type: "button",
    class: "vg-add-btn-small",
    text: "+ Add Key"
  });
  addSmall.addEventListener("click", () => {
    openAddKeyModal(() => updateChipsContainer(container));
  });
  wrapper.append(addSmall);

  container.append(wrapper);
}

plugin.dom.observe('input[type="password"]', (input) => {
  try {
    if (input.dataset.voidgravityEnhanced) return;

    // Check if this input is in the Gemini API key row
    const row = input.closest(".py-2");
    if (!row) return;

    const rowText = row.textContent || "";
    if (!rowText.includes("Gemini API key")) return;

    input.dataset.voidgravityEnhanced = "true";

    // 1. Add "+" icon button directly next to the password input field
    const controlCell = input.parentElement;
    if (controlCell) {
      controlCell.style.display = "flex";
      controlCell.style.alignItems = "center";
      controlCell.style.gap = "6px";

      const plusBtn = plugin.ui.element("button", {
        type: "button",
        class: plugin.ui.classes.buttonQuiet,
        title: "Add fallback API key (+)",
        "aria-label": "Add fallback API key"
      });
      plusBtn.style.display = "inline-flex";
      plusBtn.style.alignItems = "center";
      plusBtn.style.justifyContent = "center";
      plusBtn.style.cursor = "pointer";
      plusBtn.style.borderRadius = "6px";
      plusBtn.style.border = "1px solid rgba(120, 120, 120, 0.3)";
      plusBtn.style.background = "rgba(120, 120, 120, 0.15)";
      plusBtn.style.width = "28px";
      plusBtn.style.height = "28px";
      plusBtn.append(plugin.ui.icon(plugin.ui.icons.plus, 16));

      plusBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openAddKeyModal(() => {
          if (chipsContainer) updateChipsContainer(chipsContainer);
        });
      });

      controlCell.append(plusBtn);
    }

    // 2. Add key chips below the row
    let chipsContainer = row.querySelector(".vg-key-container");
    if (!chipsContainer) {
      chipsContainer = plugin.ui.element("div", { class: "vg-key-container" });
      const textCell = row.querySelector(".flex-1");
      if (textCell) {
        textCell.append(chipsContainer);
      } else {
        row.append(chipsContainer);
      }
    }

    updateChipsContainer(chipsContainer);
  } catch (err) {
    plugin.log.error("Failed to enhance Gemini key row:", err);
  }
});

// ---------------------------------------------------------------------------
// Lifecycle & Status Reporting
// ---------------------------------------------------------------------------

let announced = "";

plugin.onDispose(
  gemini.onStatusChanged((status) => {
    plugin.log.info(`Gemini ${status.phase}${status.message ? `: ${status.message}` : ""}`);
    const worth = status.phase === "blocked" || status.phase === "listening";
    const notice = worth ? status.message : undefined;
    if (!notice || notice === announced) return;
    announced = notice;
    plugin.ui.toast({
      title: "Custom Gemini API Key",
      body: notice,
      kind: status.phase === "blocked" ? "warning" : "info"
    });
  })
);

plugin.onDispose(plugin.settings.onChange(() => void push()));

void push();

if (!READY) {
  plugin.ui.toast({
    title: "VoidGravity Gemini Engine",
    body: "Settings saved. Restart Antigravity to send chat through your key pool.",
    kind: "info"
  });
}
