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
  const items = readCart();
  const line = items.find((i) => i.id === product.id);
  if (line) line.qty += qty;
  else items.push({ id: product.id, title: product.title, price: product.price, image: product.image, qty });
  writeCart(items);
}

function cartTotal(items) {
  return items.reduce((sum, i) => sum + Number(i.price) * i.qty, 0).toFixed(2);
}

function renderCartCount() {
  const el = document.getElementById("cart-count");
  if (el) el.textContent = readCart().reduce((n, i) => n + i.qty, 0);
}

function stars(rating, reviews) {
  const full = Math.round(rating);
  return `<span class="stars" aria-label="${rating} out of 5">${"★".repeat(full)}${"☆".repeat(5 - full)}<small>${rating} (${reviews})</small></span>`;
}

function productCard(p) {
  return `
    <a class="card" href="/product/${p.id}">
      <div class="card-media">
        <img src="${p.image}" alt="${p.title}" loading="lazy">
        ${p.badge ? `<span class="badge">${p.badge}</span>` : ""}
      </div>
      <h3>${p.title}</h3>
      <div class="meta"><span class="price">$${p.price}</span>${stars(p.rating, p.reviews)}</div>
    </a>`;
}

document.addEventListener("DOMContentLoaded", renderCartCount);
