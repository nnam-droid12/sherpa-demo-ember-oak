// Tiny cart kept in localStorage, plus shared rendering helpers.
const CART_KEY = "ember-oak-cart";

function readCart() {
  try {
    const data = JSON.parse(localStorage.getItem(CART_KEY));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeCart(items) {
  localStorage.setItem(CART_KEY, JSON.stringify(Array.isArray(items) ? items : []));
  renderCartCount();
}

function addToCart(product, qty = 1) {
  if (!product || !product.id) return;
  const items = readCart();
  const quantity = Math.max(1, parseInt(qty, 10) || 1);
  const line = items.find((i) => i.id === product.id);
  if (line) {
    line.qty = (line.qty || 0) + quantity;
  } else {
    items.push({
      id: product.id,
      title: product.title || "",
      price: product.price || "0.00",
      image: product.image || "",
      qty: quantity,
    });
  }
  writeCart(items);
}

function cartTotal(items) {
  if (!Array.isArray(items)) return "0.00";
  return items.reduce((sum, i) => sum + (Number(i.price) || 0) * (Number(i.qty) || 1), 0).toFixed(2);
}

function renderCartCount() {
  const el = document.getElementById("cart-count");
  if (el) el.textContent = readCart().reduce((n, i) => n + (Number(i.qty) || 0), 0);
}

function stars(rating, reviews) {
  const num = Number(rating) || 0;
  const full = Math.min(5, Math.max(0, Math.round(num)));
  const rev = reviews !== undefined && reviews !== null ? reviews : 0;
  return `<span class="stars" aria-label="${num} out of 5">${"★".repeat(full)}${"☆".repeat(5 - full)}<small>${num} (${rev})</small></span>`;
}

function productCard(p) {
  if (!p) return "";
  const title = p.title || "";
  const image = p.image || "";
  const price = p.price || "0.00";
  return `
    <a class="card" href="/product/${p.id || ""}">
      <div class="card-media">
        <img src="${image}" alt="${title}" loading="lazy">
        ${p.badge ? `<span class="badge">${p.badge}</span>` : ""}
      </div>
      <h3>${title}</h3>
      <div class="meta"><span class="price">$${price}</span>${stars(p.rating, p.reviews)}</div>
    </a>`;
}

document.addEventListener("DOMContentLoaded", renderCartCount);
