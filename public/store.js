// Tiny cart kept in localStorage, plus shared rendering helpers.
const CART_KEY = "ember-oak-cart";

function readCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY)) || [];
  } catch {
    return [];
  }
}

function writeCart(items) {
  localStorage.setItem(CART_KEY, JSON.stringify(items));
  renderCartCount();
}

function addToCart(product, qty = 1) {
  if (!product || !product.id) return;
  const items = readCart();
  const line = items.find((i) => i.id === product.id);
  const addQty = Math.max(1, Number(qty) || 1);
  if (line) line.qty += addQty;
  else items.push({ id: product.id, title: product.title || "", price: product.price || "0.00", image: product.image || "", qty: addQty });
  writeCart(items);
}

function cartTotal(items) {
  if (!Array.isArray(items)) return "0.00";
  return items.reduce((sum, i) => sum + Number(i?.price || 0) * (Number(i?.qty) || 1), 0).toFixed(2);
}

function renderCartCount() {
  const el = document.getElementById("cart-count");
  if (el) el.textContent = readCart().reduce((n, i) => n + (Number(i?.qty) || 1), 0);
}

function stars(rating = 0, reviews = 0) {
  const full = Math.round(Number(rating) || 0);
  return `<span class="stars" aria-label="${rating} out of 5">${"★".repeat(Math.max(0, Math.min(5, full)))}${"☆".repeat(Math.max(0, 5 - full))}<small>${rating} (${reviews})</small></span>`;
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
