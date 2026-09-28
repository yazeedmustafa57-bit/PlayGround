const KEY = "taskpro-simple-v1";
const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const form = document.getElementById("add-form");
const inputText = document.getElementById("input-text");
const inputCategory = document.getElementById("input-category");

let items = load();
let filter = "all";

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
    const old = localStorage.getItem("taskpro-v2") || localStorage.getItem("aufgaben-manager-v1");
    if (old) {
      const arr = JSON.parse(old);
      if (Array.isArray(arr)) {
        return arr
          .filter((x) => x && x.text)
          .map((x) => ({ id: String(x.id || Date.now() + Math.random()), text: String(x.text).slice(0, 120), category: x.category || "Sonstiges", done: Boolean(x.done) }));
      }
    }
  } catch { /* neu starten */ }
  return [
    { id: "1", text: "Milch kaufen", category: "Lebensmittel", done: false },
    { id: "2", text: "Brot kaufen", category: "Lebensmittel", done: false },
  ];
}
function save() { localStorage.setItem(KEY, JSON.stringify(items)); }

function render() {
  const vis = items.filter((it) =>
    filter === "all" ? true : filter === "open" ? !it.done : it.done
  );
  listEl.innerHTML = "";
  for (const it of vis) {
    const li = document.createElement("li");
    li.className = "item" + (it.done ? " done" : "");

    const btn = document.createElement("button");
    btn.className = "checkbox";
    btn.textContent = it.done ? "✓" : "";
    btn.setAttribute("aria-label", "Abhaken");
    btn.onclick = () => { it.done = !it.done; save(); render(); };

    const span = document.createElement("span");
    span.className = "text";
    span.textContent = it.text;
    span.onclick = () => { it.done = !it.done; save(); render(); };

    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = it.category;

    const del = document.createElement("button");
    del.className = "delete";
    del.textContent = "🗑️";
    del.setAttribute("aria-label", "Löschen");
    del.onclick = () => { items = items.filter((x) => x.id !== it.id); save(); render(); };

    li.append(btn, span, badge, del);
    listEl.appendChild(li);
  }
  emptyEl.style.display = vis.length ? "none" : "block";

  const total = items.length;
  const done = items.filter((x) => x.done).length;
  document.getElementById("count-total").textContent = total;
  document.getElementById("count-open").textContent = total - done;
  document.getElementById("count-done").textContent = done;
  document.getElementById("progress-text").textContent = `${done} von ${total} erledigt`;
  document.getElementById("progress-pct").textContent = total ? Math.round((done / total) * 100) + "%" : "0%";
  document.getElementById("progress-bar").style.width = total ? (done / total) * 100 + "%" : "0%";
}

form.onsubmit = (e) => {
  e.preventDefault();
  const v = inputText.value.trim();
  if (!v) return;
  items.unshift({ id: String(Date.now()), text: v, category: inputCategory.value, done: false });
  save(); render();
  inputText.value = "";
  inputText.focus();
};

document.querySelectorAll(".filters button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".filters button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    filter = b.dataset.filter;
    render();
  };
});

document.getElementById("clear-done").onclick = () => {
  if (!items.some((x) => x.done)) return;
  if (confirm("Erledigte wirklich löschen?")) {
    items = items.filter((x) => !x.done);
    save(); render();
  }
};

render();
