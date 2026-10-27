// Build step: make sure the server loads and every view and product image exists.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
require(path.join(root, "server.js"));

const products = require(path.join(root, "products.json"));
for (const view of ["index.html", "product.html", "cart.html", "thank-you.html"]) {
  if (!fs.existsSync(path.join(root, "views", view))) throw new Error(`missing view ${view}`);
}
for (const p of products) {
  if (!fs.existsSync(path.join(root, "public", p.image))) throw new Error(`missing image ${p.image}`);
}
console.log(`ok: ${products.length} products`);
