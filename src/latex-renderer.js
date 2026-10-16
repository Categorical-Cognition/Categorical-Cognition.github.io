const GREEK_COMMANDS = Object.freeze({
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
});

const SYMBOL_COMMANDS = Object.freeze({
  circ: "∘",
  cdot: "·",
  times: "×",
  leq: "≤",
  geq: "≥",
  neq: "≠",
  approx: "≈",
  sim: "∼",
  equiv: "≡",
  in: "∈",
  notin: "∉",
  subset: "⊂",
  subseteq: "⊆",
  supset: "⊃",
  supseteq: "⊇",
  cup: "∪",
  cap: "∩",
  forall: "∀",
  exists: "∃",
  emptyset: "∅",
  infinity: "∞",
  infty: "∞",
  partial: "∂",
  nabla: "∇",
  sum: "∑",
  prod: "∏",
  int: "∫",
  to: "→",
  mapsto: "↦",
  leftarrow: "←",
  rightarrow: "→",
  leftrightarrow: "↔",
  Leftarrow: "⇐",
  Rightarrow: "⇒",
  Leftrightarrow: "⇔",
});

const COMMANDS = Object.freeze({
  ...GREEK_COMMANDS,
  ...SYMBOL_COMMANDS,
});

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stripMathDelimiters(source) {
  return String(source ?? "")
    .replace(/\\begin\{(?:equation\*?|align\*?|gather\*?)\}/g, "")
    .replace(/\\end\{(?:equation\*?|align\*?|gather\*?)\}/g, "")
    .replace(/\\\[/g, "")
    .replace(/\\\]/g, "")
    .replace(/\\\(/g, "")
    .replace(/\\\)/g, "")
    .replace(/\$\$/g, "")
    .replace(/\$/g, "");
}

function renderSimpleGroups(html) {
  let next = html;
  for (let index = 0; index < 6; index += 1) {
    const previous = next;
    next = next
      .replace(
        /\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g,
        '<span class="latex-frac"><span>$1</span><span>$2</span></span>',
      )
      .replace(
        /\\sqrt\s*\{([^{}]*)\}/g,
        '<span class="latex-root">√<span>$1</span></span>',
      )
      .replace(/\\(?:text|mathrm|operatorname)\s*\{([^{}]*)\}/g, "$1")
      .replace(/\^\s*\{([^{}]*)\}/g, "<sup>$1</sup>")
      .replace(/_\s*\{([^{}]*)\}/g, "<sub>$1</sub>");
    if (next === previous) {
      break;
    }
  }
  return next
    .replace(/\^\s*([A-Za-z0-9+\-=])/g, "<sup>$1</sup>")
    .replace(/_\s*([A-Za-z0-9+\-=])/g, "<sub>$1</sub>");
}

export function renderLatexSnippetToHtml(source) {
  const cleaned = stripMathDelimiters(source).trim();
  if (!cleaned) {
    return '<span class="latex-empty">Empty LaTeX snippet</span>';
  }

  return renderSimpleGroups(escapeHtml(cleaned))
    .replace(/\\\\/g, "<br>")
    .replace(/\\([A-Za-z]+)\b/g, (match, command) => COMMANDS[command] ?? match)
    .replace(/\\[,;:!]/g, " ")
    .replace(/\\left|\\right/g, "")
    .replace(/[{}]/g, "");
}

export function renderLatexSnippetInto(element, source) {
  if (!element) {
    return;
  }
  element.innerHTML = renderLatexSnippetToHtml(source);
}
