// Tiny cart kept in localStorage.
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
  else items.push({ id: product.id, title: product.title, price: product.price, qty });
  writeCart(items);
}

function cartTotal(items) {
  return items.reduce((sum, i) => sum + Number(i.price) * i.qty, 0).toFixed(2);
}

function renderCartCount() {
  const el = document.getElementById("cart-count");
  if (el) el.textContent = readCart().reduce((n, i) => n + i.qty, 0);
}

document.addEventListener("DOMContentLoaded", renderCartCount);
