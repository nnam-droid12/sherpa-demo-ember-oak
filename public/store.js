// Tiny cart kept in localStorage, plus shared rendering helpers.
const CART_KEY = "ember-oak-cart";

function readCart() {
  try {
    const items = JSON.parse(localStorage.getItem(CART_KEY));
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function writeCart(items) {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(items));
  } catch (e) {
    console.error("Failed to write cart:", e);
  }
  renderCartCount();
}

function addToCart(product, qty = 1) {
  if (!product || !product.id) return;
  const items = readCart();
  const validQty = Math.max(1, Number(qty) || 1);
  const line = items.find((i) => i && i.id === product.id);
  if (line) {
    line.qty = (Number(line.qty) || 0) + validQty;
  } else {
    items.push({
      id: product.id,
      title: product.title || "",
      price: product.price || "0.00",
      image: product.image || "",
      qty: validQty,
    });
  }
  writeCart(items);
}

function cartTotal(items) {
  if (!Array.isArray(items)) return "0.00";
  return items
    .reduce((sum, i) => sum + (Number(i && i.price) || 0) * (Number(i && i.qty) || 1), 0)
    .toFixed(2);
}

function renderCartCount() {
  const el = document.getElementById("cart-count");
  if (el) el.textContent = readCart().reduce((n, i) => n + (Number(i && i.qty) || 1), 0);
}

function stars(rating, reviews) {
  const num = Number(rating);
  const validRating = isNaN(num) ? 0 : num;
  const full = Math.min(5, Math.max(0, Math.round(validRating)));
  const revText = reviews ? ` (${reviews})` : "";
  return `<span class="stars" aria-label="${validRating} out of 5">${"★".repeat(full)}${"☆".repeat(5 - full)}<small>${validRating}${revText}</small></span>`;
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
