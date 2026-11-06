// Tiny cart kept in localStorage, plus shared rendering helpers.
const CART_KEY = "ember-oak-cart";

function readCart() {
  try {
    const raw = localStorage.getItem(CART_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeCart(items) {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(items || []));
  } catch {}
  renderCartCount();
}

function addToCart(product, qty = 1) {
  if (!product || !product.id) return;
  const items = readCart();
  const q = Math.max(1, Number(qty) || 1);
  const line = items.find((i) => i && i.id === product.id);
  if (line) {
    line.qty = (Number(line.qty) || 0) + q;
  } else {
    items.push({
      id: product.id,
      title: product.title || "",
      price: product.price || "0.00",
      image: product.image || "",
      qty: q,
    });
  }
  writeCart(items);
}

function cartTotal(items) {
  if (!Array.isArray(items)) return "0.00";
  return items.reduce((sum, i) => sum + (Number(i && i.price) || 0) * (Number(i && i.qty) || 1), 0).toFixed(2);
}

function renderCartCount() {
  const el = document.getElementById("cart-count");
  if (el) el.textContent = readCart().reduce((n, i) => n + (Number(i && i.qty) || 0), 0);
}

function stars(rating, reviews) {
  const r = Number(rating) || 0;
  const rev = Number(reviews) || 0;
  const full = Math.max(0, Math.min(5, Math.round(r)));
  return `<span class="stars" aria-label="${r} out of 5">${"★".repeat(full)}${"☆".repeat(5 - full)}<small>${r} (${rev})</small></span>`;
}

function productCard(p) {
  if (!p) return "";
  return `
    <a class="card" href="/product/${p.id || ""}">
      <div class="card-media">
        <img src="${p.image || ""}" alt="${p.title || ""}" loading="lazy">
        ${p.badge ? `<span class="badge">${p.badge}</span>` : ""}
      </div>
      <h3>${p.title || ""}</h3>
      <div class="meta"><span class="price">$${p.price || "0.00"}</span>${stars(p.rating, p.reviews)}</div>
    </a>`;
}

document.addEventListener("DOMContentLoaded", renderCartCount);
