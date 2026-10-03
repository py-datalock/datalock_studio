/**
 * a11y.js
 * =======
 * Acessibilidade dos diálogos (modais, gavetas laterais, tutorial) sem mexer no template de cada um.
 * Para cada diálogo que aparece na tela, este módulo:
 *   - marca role="dialog" e aria-modal="true", ligando o título (h2) via aria-labelledby;
 *   - move o foco para dentro (campo marcado, ou o primeiro controle) e PRENDE o Tab ali dentro;
 *   - devolve o foco ao elemento que o abriu quando o diálogo fecha.
 * O Esc continua tratado pelo app.js. Não depende do Vue — observa o DOM.
 */

const DIALOG_SELECTOR = ".modal, .drawer, .onboarding-card";
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const stack = []; // { el, opener }
let uid = 0;

function visibleFocusables(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

function enhance(el) {
  if (el.dataset.a11y === "1") return;
  el.dataset.a11y = "1";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  const title = el.querySelector("h1, h2, h3");
  if (title) {
    if (!title.id) title.id = `dl-dialog-title-${++uid}`;
    el.setAttribute("aria-labelledby", title.id);
  }
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  stack.push({ el, opener });
  // espera o Vue terminar de pintar o conteúdo antes de escolher onde pôr o foco
  requestAnimationFrame(() => {
    const preferred = el.querySelector("[autofocus], input:not([type=hidden]):not([disabled]), textarea, select");
    (preferred || visibleFocusables(el)[0] || el).focus({ preventScroll: true });
  });
}

function release(el) {
  const i = stack.findIndex((d) => d.el === el);
  if (i === -1) return;
  const [{ opener }] = stack.splice(i, 1);
  if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
}

const observer = new MutationObserver((mutations) => {
  for (const m of mutations) {
    m.addedNodes.forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      if (node.matches?.(DIALOG_SELECTOR)) enhance(node);
      node.querySelectorAll?.(DIALOG_SELECTOR).forEach(enhance);
    });
    m.removedNodes.forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      if (node.matches?.(DIALOG_SELECTOR)) release(node);
      node.querySelectorAll?.(DIALOG_SELECTOR).forEach(release);
    });
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab" || !stack.length) return;
  const { el } = stack[stack.length - 1];
  const items = visibleFocusables(el);
  if (!items.length) { e.preventDefault(); el.focus(); return; }
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  else if (!el.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
});

/** Esc fecha o diálogo do topo. Roda depois do tratamento do app.js: se ele já fechou, não faz nada. */
function closeTopDialog() {
  if (!stack.length) return;
  const { el } = stack[stack.length - 1];
  if (!el.isConnected) return;
  let backdrop = el.closest(".modal-backdrop, .onboarding-backdrop");
  if (!backdrop && el.previousElementSibling?.classList.contains("drawer-backdrop")) backdrop = el.previousElementSibling;
  backdrop?.click();   // os fundos usam @click.self para fechar — o clique no próprio fundo dispara o mesmo caminho
}
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && stack.length) setTimeout(closeTopDialog, 0);
});

observer.observe(document.body, { childList: true, subtree: true });
