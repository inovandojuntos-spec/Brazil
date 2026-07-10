/* ====================================================================
   store.js — Carrito + checkout compartido (Inovando Juntos)
   Usado por landing.html y loja.html. Inyecta el carrito (drawer),
   el modal de checkout (nome/email/CEP autocompletado/telefone) y
   crea el draft order en Nuvemshop, redirigiendo al checkout pre-llenado.

   Marcado esperado en la página:
     - Botón carrito:        [data-ij-cart]      (abre el drawer)
     - Contador:             [data-ij-cart-count](texto = nº de itens)
     - Agregar al carrito:   [data-ij-add]   con data-variant-id, data-product-id, data-category-ids, data-name, data-price, data-image
     - Comprar agora:        [data-ij-buy]   con los mismos data-*
   API pública: window.IJStore.addToCart(item), .buyNow(item), .open(), .count()
   ==================================================================== */
(function () {
  "use strict";
  var ENDPOINT = "https://rsordtljnvxonaygyuxd.supabase.co/functions/v1/nuvemshop-create-draft-order";
  var STORE_KEY = "ij_cart_v2";

  /* ---------- estado ---------- */
  var cart = load();
  function load() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; } }
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(cart)); } catch (e) {} }
  function money(v) { return "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function arr() { return Object.keys(cart).map(function (k) { return cart[k]; }); }
  function count() { return arr().reduce(function (s, i) { return s + i.qty; }, 0); }
  function lineSub(i) { return (Number(i.price) || 0) * (Number(i.qty) || 0); }
  function total() { return arr().reduce(function (s, i) { return s + lineSub(i); }, 0); }

  /* ---------- cupón: scope-aware, espejo de nuvemshop-create-draft-order ----------
     Estructura guardada en ij_coupon (por la raspadinha de index.html):
       { code, pct, type:"percentage"|"absolute", value, min_price, product_ids:[], category_ids:[] }
     Compatibilidad: si solo viene { code, pct } (formato viejo) se trata como % de toda la tienda. */
  function appliedCoupon() {
    try {
      var c = JSON.parse(localStorage.getItem("ij_coupon") || "null");
      if (!c || !c.code) return null;
      // Vigencia: si el cupón aún no empezó o ya venció, se ignora (igual que la raspadinha y el backend).
      var _t = new Date(), _m = _t.getMonth() + 1, _d = _t.getDate();
      var today = _t.getFullYear() + "-" + (_m < 10 ? "0" : "") + _m + "-" + (_d < 10 ? "0" : "") + _d;
      if (c.valid_from && String(c.valid_from).slice(0, 10) > today) return null;
      if (c.valid_until && String(c.valid_until).slice(0, 10) < today) return null;
      var type = String(c.type || "percentage");
      var pct = Number(c.pct != null ? c.pct : c.value) || 0;
      var pids = (c.product_ids || []).map(Number).filter(function (x) { return x > 0; });
      var cids = (c.category_ids || []).map(Number).filter(function (x) { return x > 0; });
      if (type === "percentage" && pct <= 0) return null;
      return { code: String(c.code), type: type, pct: pct, value: Number(c.value != null ? c.value : c.pct) || 0,
               min_price: Number(c.min_price) || 0, product_ids: pids, category_ids: cids };
    } catch (e) { return null; }
  }
  function isStoreWide(c) { return c.product_ids.length === 0 && c.category_ids.length === 0; }
  // ¿La línea entra en el scope del cupón? (mismo criterio que fetchEligibleVariantPrices del backend)
  function lineEligible(i, c) {
    if (isStoreWide(c)) return true;
    var pid = Number(i.product_id) || 0;
    if (pid && c.product_ids.indexOf(pid) !== -1) return true;
    var cats = (i.category_ids || []).map(Number);
    for (var k = 0; k < cats.length; k++) if (c.category_ids.indexOf(cats[k]) !== -1) return true;
    return false;
  }
  // Subtotal de las líneas elegibles del cupón.
  function eligibleSubtotal(c) { return arr().reduce(function (s, i) { return s + (lineEligible(i, c) ? lineSub(i) : 0); }, 0); }
  // ¿Se cumple el mínimo de compra del cupón sobre el subtotal elegible?
  function couponMeetsMin(c) { return eligibleSubtotal(c) >= (c.min_price || 0); }
  function couponActive(c) {
    if (!c) return false;
    if (c.type === "absolute") return total() > 0 && total() >= (c.min_price || 0);
    return eligibleSubtotal(c) > 0 && couponMeetsMin(c); // percentage
  }
  // Descuento de UNA línea (solo % por línea elegible; absolute se trata a nivel orden).
  function lineDiscount(i, c) {
    if (!c || c.type !== "percentage") return 0;
    if (!couponActive(c) || !lineEligible(i, c)) return 0;
    return lineSub(i) * c.pct / 100;
  }
  // Descuento total (idéntico al que aplica el backend en el draft order).
  function discountAmount() {
    var c = appliedCoupon();
    if (!c || !couponActive(c)) return 0;
    if (c.type === "absolute") return Math.min(total(), c.value || 0);
    return eligibleSubtotal(c) * c.pct / 100; // percentage (storewide → todo; scoped → solo elegibles)
  }
  function grandTotal() { return Math.max(0, total() - discountAmount()); }
  function clampQty(v) { var n = parseInt(String(v).replace(/[^0-9]/g, ""), 10); if (!isFinite(n) || n < 1) n = 1; if (n > 99) n = 99; return n; }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
  function getCookie(n) { try { var m = document.cookie.match("(^|;\\s*)" + n + "=([^;]+)"); return m ? decodeURIComponent(m[2]) : ""; } catch (e) { return ""; } }
  function metaTrack(ev, params) { try { if (window.ijMeta) window.ijMeta.track(ev, params, window.ijMeta.uuid()); } catch (e) {} }
  function metaCurrency() { try { return (window.ijMeta && window.ijMeta.CURRENCY) || "BRL"; } catch (e) { return "BRL"; } }

  function addItem(item, qty) {
    var key = String(item.variant_id);
    qty = clampQty(qty || 1);
    if (!key || key === "NaN") return;
    if (cart[key]) cart[key].qty = clampQty(cart[key].qty + qty);
    else cart[key] = {
      variant_id: Number(item.variant_id),
      product_id: Number(item.product_id) || 0,
      category_ids: (item.category_ids || []).map(Number).filter(function (x) { return x > 0; }),
      name: item.name || "Produto",
      price: Number(item.price) || 0,
      image: item.image || "",
      qty: qty
    };
    save(); updateCounts();
    // Meta · AddToCart
    metaTrack("AddToCart", { content_ids: [String(item.variant_id)], content_type: "product", value: (Number(item.price) || 0) * qty, currency: metaCurrency(), contents: [{ id: String(item.variant_id), quantity: qty }] });
  }
  function setQty(key, qty) { if (cart[key]) { cart[key].qty = clampQty(qty); save(); updateCounts(); renderDrawer(); } }
  function removeItem(key) { delete cart[key]; save(); updateCounts(); renderDrawer(); }

  /* ---------- estilos + markup inyectado ---------- */
  function injectUI() {
    var css = document.createElement("style");
    css.textContent = [
      ".ij-ov{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.62);backdrop-filter:blur(4px);opacity:0;transition:opacity .25s ease}",
      ".ij-ov[hidden]{display:none}.ij-ov.show{opacity:1}",
      ".ij-drawer{position:fixed;top:0;right:0;height:100%;width:min(420px,100%);z-index:1001;background:#0a0a0a;border-left:1px solid rgba(255,255,255,.10);display:flex;flex-direction:column;transform:translateX(100%);transition:transform .28s ease;font-family:'Manrope',system-ui,sans-serif;color:#fff}",
      ".ij-drawer.show{transform:none}",
      ".ij-dh{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid rgba(255,255,255,.10)}",
      ".ij-dh h2{margin:0;font-size:17px;font-weight:800}",
      ".ij-x{background:none;border:0;color:#888;font-size:26px;line-height:1;cursor:pointer}.ij-x:hover{color:#fff}",
      ".ij-items{flex:1;overflow:auto;padding:14px 18px;display:flex;flex-direction:column;gap:14px}",
      ".ij-empty{color:#999;text-align:center;margin:44px 0}",
      ".ij-it{display:flex;gap:12px}",
      ".ij-it .im{width:60px;height:60px;border-radius:10px;background:#111 center/cover no-repeat;border:1px solid rgba(255,255,255,.10);flex:none}",
      ".ij-it .nm{font-size:13.5px;font-weight:700;display:block}",
      ".ij-it .pr{color:#ddd;font-size:13px;margin-top:3px}",
      ".ij-it .ln{margin-top:4px;font-size:12px;line-height:1.5}",
      ".ij-it .ln .row{display:flex;justify-content:space-between;gap:10px}",
      ".ij-it .ln .row .base{color:#bcbcbc}",
      ".ij-it .ln .row.disc{color:#9fd6b0;font-weight:700}",
      ".ij-it .ln .row.lt{color:#fff;font-weight:800}",
      ".ij-it .ln .row.lt span:first-child{color:#9a9a9a;font-weight:600}",
      ".ij-qty{display:inline-flex;align-items:center;border:1px solid #2a2a2a;border-radius:10px;overflow:hidden;margin-top:8px}",
      ".ij-qty button{width:32px;height:34px;background:transparent;border:0;color:#fff;font-size:17px;cursor:pointer}.ij-qty button:hover{background:rgba(255,255,255,.07)}",
      ".ij-qty input{width:36px;height:34px;text-align:center;background:transparent;border:0;color:#fff;font-size:14px;font-family:inherit}",
      ".ij-rm{background:none;border:0;color:#888;cursor:pointer;font-size:12px;text-decoration:underline;padding:0;margin-top:6px;display:block}",
      ".ij-foot{border-top:1px solid rgba(255,255,255,.10);padding:18px}",
      ".ij-sub{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;color:#9a9a9a;font-size:12.5px}.ij-sub[hidden]{display:none}.ij-sub span:last-child{color:#cfcfcf}",
      ".ij-disc{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;color:#9fd6b0;font-size:12.5px;font-weight:700}.ij-disc[hidden]{display:none}.ij-disc span:last-child{color:#9fd6b0}",
      ".ij-min{margin:-2px 0 8px;color:#caa15f;font-size:11.5px}.ij-min[hidden]{display:none}",
      ".ij-tot{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px}.ij-tot span{color:#aaa;font-size:13px}.ij-tot b{font-family:'Jost',system-ui,sans-serif;font-size:24px;font-weight:500}",
      ".ij-btn{display:block;width:100%;border:0;border-radius:12px;padding:14px;font-family:'Manrope',sans-serif;font-weight:800;font-size:14px;letter-spacing:.03em;background:#fff;color:#000;cursor:pointer;text-align:center}",
      ".ij-btn:hover{box-shadow:0 8px 20px rgba(0,0,0,.5)}.ij-btn[disabled]{opacity:.45;cursor:not-allowed;box-shadow:none}",
      ".ij-keep{display:inline-flex;align-items:center;gap:8px;width:max-content;max-width:100%;margin:14px auto 2px;background:none;border:0;color:#e07a3f;font-family:inherit;font-weight:800;font-size:13px;letter-spacing:.04em;cursor:pointer;padding:6px 8px}",
      ".ij-keep .ij-keep-ar{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;border:1px solid rgba(224,122,63,.6);font-size:14px;line-height:1;transition:transform .2s ease,background .2s ease}",
      ".ij-keep:hover{color:#fff}.ij-keep:hover .ij-keep-ar{transform:translateX(3px);background:rgba(224,122,63,.16)}",
      ".ij-card{position:relative;width:100%;max-width:430px;background:#111;border:1px solid rgba(255,255,255,.14);border-radius:22px;padding:34px 30px;box-shadow:0 30px 80px rgba(0,0,0,.6);font-family:'Manrope',sans-serif;color:#fff;max-height:92vh;overflow:auto}",
      ".ij-modal{position:fixed;inset:0;z-index:1002;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.72);backdrop-filter:blur(6px);opacity:0;transition:opacity .25s ease}",
      ".ij-modal[hidden]{display:none}.ij-modal.show{opacity:1}",
      ".ij-card h3{margin:0 0 6px;font-size:24px;font-weight:400;font-family:'Jost',system-ui,sans-serif}",
      ".ij-card .sub{margin:0 0 20px;color:#aaa;font-size:13.5px}",
      ".ij-f{display:block;margin-bottom:14px}.ij-f span{display:block;color:#cfcfcf;font-size:12.5px;margin-bottom:7px}.ij-f i{color:#888;font-style:normal}",
      ".ij-f input{width:100%;box-sizing:border-box;background:#0a0a0a;border:1px solid #2a2a2a;border-radius:12px;padding:13px 14px;color:#fff;font-size:15px;font-family:inherit}",
      ".ij-f input:focus{outline:none;border-color:#666}",
      ".ij-cep-info{font-size:12px;color:#9fbf9f;margin:-6px 0 14px;min-height:15px}",
      ".ij-err{color:#ff8a8a;font-size:13px;margin:12px 0 0;text-align:center}",
      ".ij-note{color:#888;font-size:12px;text-align:center;margin:14px 0 0}",
      ".ij-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(20px);z-index:1003;background:#fff;color:#000;padding:12px 20px;border-radius:999px;font-family:'Manrope',sans-serif;font-weight:700;font-size:13px;opacity:0;transition:all .25s ease;pointer-events:none}",
      ".ij-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}"
    ].join("");
    document.head.appendChild(css);

    var wrap = document.createElement("div");
    wrap.innerHTML =
      '<div class="ij-ov" id="ijOv" hidden></div>' +
      '<aside class="ij-drawer" id="ijDrawer" aria-label="Carrinho" aria-hidden="true">' +
        '<div class="ij-dh"><h2>Seu carrinho</h2><button class="ij-x" id="ijClose" aria-label="Fechar">&times;</button></div>' +
        '<div class="ij-items" id="ijItems"></div>' +
        '<div class="ij-foot">' +
          '<div class="ij-sub" id="ijSub" hidden><span>Subtotal</span><span id="ijSubVal"></span></div>' +
          '<div class="ij-disc" id="ijDisc" hidden><span data-lbl></span><span id="ijDiscVal"></span></div>' +
          '<div class="ij-min" id="ijMin" hidden></div>' +
          '<div class="ij-tot"><span>Total</span> <b id="ijTotal">R$ 0,00</b></div>' +
          '<button class="ij-btn" id="ijCheckout" disabled>Finalizar compra</button>' +
          '<button class="ij-keep" id="ijKeep">Ver + produtos <span class="ij-keep-ar">&rarr;</span></button>' +
        '</div>' +
      '</aside>' +
      '<div class="ij-modal" id="ijModal" hidden role="dialog" aria-modal="true">' +
        '<div class="ij-card">' +
          '<button class="ij-x" id="ijMx" style="position:absolute;top:14px;right:16px" aria-label="Fechar">&times;</button>' +
          '<h3>Quase lá</h3>' +
          '<p class="sub" id="ijSummary">Preencha seus dados para ir ao pagamento.</p>' +
          '<form id="ijForm" novalidate>' +
            '<label class="ij-f"><span>Nome completo</span><input type="text" id="ijName" autocomplete="name" required placeholder="Nome e sobrenome"></label>' +
            '<label class="ij-f"><span>E-mail</span><input type="email" id="ijEmail" autocomplete="email" required placeholder="seu@email.com"></label>' +
            '<label class="ij-f"><span>CEP</span><input type="text" id="ijCep" inputmode="numeric" autocomplete="postal-code" placeholder="00000-000" maxlength="9"></label>' +
            '<div class="ij-cep-info" id="ijCepInfo"></div>' +
            '<label class="ij-f"><span>WhatsApp <i>(opcional)</i></span><input type="tel" id="ijPhone" autocomplete="tel" inputmode="tel" placeholder="(00) 00000-0000"></label>' +
            '<button class="ij-btn" type="submit" id="ijSubmit">Ir para o pagamento</button>' +
            '<p class="ij-err" id="ijErr" hidden></p>' +
            '<p class="ij-note">Endereço completo e pagamento você confirma no checkout seguro da Nuvemshop.</p>' +
          '</form>' +
        '</div>' +
      '</div>' +
      '<div class="ij-toast" id="ijToast"></div>';
    document.body.appendChild(wrap);
  }

  /* ---------- referencias ---------- */
  var ov, drawer, itemsBox, totalEl, checkoutBtn, modal, form, elName, elEmail, elCep, elCepInfo, elPhone, elErr, elSubmit, summaryEl, toastEl;
  var cepResolved = null; // { address, city, province, zipcode }

  function grab() {
    ov = document.getElementById("ijOv");
    drawer = document.getElementById("ijDrawer");
    itemsBox = document.getElementById("ijItems");
    totalEl = document.getElementById("ijTotal");
    checkoutBtn = document.getElementById("ijCheckout");
    modal = document.getElementById("ijModal");
    form = document.getElementById("ijForm");
    elName = document.getElementById("ijName");
    elEmail = document.getElementById("ijEmail");
    elCep = document.getElementById("ijCep");
    elCepInfo = document.getElementById("ijCepInfo");
    elPhone = document.getElementById("ijPhone");
    elErr = document.getElementById("ijErr");
    elSubmit = document.getElementById("ijSubmit");
    summaryEl = document.getElementById("ijSummary");
    toastEl = document.getElementById("ijToast");
  }

  /* ---------- contador / toast ---------- */
  function updateCounts() {
    var c = count();
    document.querySelectorAll("[data-ij-cart-count]").forEach(function (el) { el.textContent = c; });
    if (totalEl) totalEl.textContent = money(grandTotal());

    var cup = appliedCoupon(), da = discountAmount();
    var subRow = document.getElementById("ijSub");
    var dRow = document.getElementById("ijDisc");
    var minRow = document.getElementById("ijMin");

    if (dRow) {
      if (cup && da > 0) {
        dRow.hidden = false;
        if (subRow) { subRow.hidden = false; var sv = document.getElementById("ijSubVal"); if (sv) sv.textContent = money(total()); }
        var lbl = dRow.querySelector("[data-lbl]");
        if (lbl) lbl.textContent = "Desconto " + cup.code + (cup.type === "percentage" ? " (−" + cup.pct + "%)" : "");
        var dv = document.getElementById("ijDiscVal"); if (dv) dv.textContent = "− " + money(da);
      } else {
        dRow.hidden = true;
        if (subRow) subRow.hidden = true;
      }
    }

    // Nota: cupón presente pero no alcanza el mínimo de compra → falta para activarlo.
    if (minRow) {
      if (cup && da === 0 && cup.type === "percentage" && (cup.min_price || 0) > 0) {
        var sub = eligibleSubtotal(cup), falta = (cup.min_price || 0) - sub;
        if (falta > 0) { minRow.hidden = false; minRow.textContent = "Cupom " + cup.code + ": adicione " + money(falta) + " em produtos elegíveis para ativar o desconto."; }
        else minRow.hidden = true;
      } else { minRow.hidden = true; }
    }

    if (checkoutBtn) checkoutBtn.disabled = c === 0;
  }
  var toastT;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg; toastEl.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(function () { toastEl.classList.remove("show"); }, 1800);
  }

  /* ---------- drawer ---------- */
  function openDrawer() { renderDrawer(); ov.hidden = false; requestAnimationFrame(function () { ov.classList.add("show"); drawer.classList.add("show"); }); drawer.setAttribute("aria-hidden", "false"); }
  function closeDrawer() { ov.classList.remove("show"); drawer.classList.remove("show"); drawer.setAttribute("aria-hidden", "true"); setTimeout(function () { ov.hidden = true; }, 280); }
  function renderDrawer() {
    var list = arr();
    if (!list.length) { itemsBox.innerHTML = '<div class="ij-empty">Seu carrinho está vazio.</div>'; updateCounts(); return; }
    itemsBox.innerHTML = "";
    var cup = appliedCoupon();
    list.forEach(function (i) {
      var el = document.createElement("div");
      el.className = "ij-it";
      var ld = lineDiscount(i, cup);                 // descuento de esta línea (0 si no elegible)
      var lt = Math.max(0, lineSub(i) - ld);         // total por producto (ya con descuento)
      var lines =
        '<div class="ln">' +
          '<div class="row"><span>Preço</span><span class="base">' + money(i.price) + ' × ' + i.qty + '</span></div>' +
          (ld > 0 ? '<div class="row disc"><span>Cupom ' + esc(cup.code) + (cup.type === "percentage" ? " (−" + cup.pct + "%)" : "") + '</span><span>− ' + money(ld) + '</span></div>' : '') +
          '<div class="row lt"><span>Total</span><span>' + money(lt) + '</span></div>' +
        '</div>';
      el.innerHTML =
        '<div class="im" style="background-image:url(\'' + i.image + '\')"></div>' +
        '<div style="flex:1;min-width:0">' +
          '<span class="nm">' + esc(i.name) + '</span>' +
          lines +
          '<div class="ij-qty"><button type="button" data-d>−</button><input type="text" value="' + i.qty + '" inputmode="numeric"><button type="button" data-i>+</button></div>' +
          '<button class="ij-rm" type="button">Remover</button>' +
        '</div>';
      var input = el.querySelector("input");
      el.querySelector("[data-d]").addEventListener("click", function () { setQty(String(i.variant_id), i.qty - 1); });
      el.querySelector("[data-i]").addEventListener("click", function () { setQty(String(i.variant_id), i.qty + 1); });
      input.addEventListener("change", function () { setQty(String(i.variant_id), input.value); });
      el.querySelector(".ij-rm").addEventListener("click", function () { removeItem(String(i.variant_id)); });
      itemsBox.appendChild(el);
    });
    updateCounts();
  }

  /* ---------- checkout modal ---------- */
  function openCheckout() {
    if (count() === 0) return;
    summaryEl.textContent = count() + " item(ns) · " + money(grandTotal()) + (appliedCoupon() ? "  ·  cupom " + appliedCoupon().code : "");
    elErr.hidden = true;
    modal.hidden = false; requestAnimationFrame(function () { modal.classList.add("show"); });
    setTimeout(function () { elName.focus(); }, 60);
    // Meta · InitiateCheckout
    metaTrack("InitiateCheckout", { value: grandTotal(), currency: metaCurrency(), num_items: count(), content_type: "product", content_ids: arr().map(function (i) { return String(i.variant_id); }), contents: arr().map(function (i) { return { id: String(i.variant_id), quantity: i.qty }; }) });
  }
  function closeCheckout() { modal.classList.remove("show"); setTimeout(function () { modal.hidden = true; }, 250); }

  /* ---------- CEP (ViaCEP) ---------- */
  function onCepInput() {
    var raw = elCep.value.replace(/\D/g, "").slice(0, 8);
    elCep.value = raw.length > 5 ? raw.slice(0, 5) + "-" + raw.slice(5) : raw;
    cepResolved = null; elCepInfo.textContent = "";
    if (raw.length === 8) lookupCep(raw);
  }
  function lookupCep(cep) {
    elCepInfo.style.color = "#9a9a9a"; elCepInfo.textContent = "Buscando endereço…";
    fetch("https://viacep.com.br/ws/" + cep + "/json/")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || d.erro) { elCepInfo.style.color = "#caa"; elCepInfo.textContent = "CEP não encontrado (você completa no checkout)."; return; }
        cepResolved = { address: d.logradouro || "", city: d.localidade || "", province: d.uf || "", zipcode: cep };
        elCepInfo.style.color = "#9fbf9f";
        elCepInfo.textContent = [d.logradouro, d.bairro, (d.localidade ? d.localidade + "/" + d.uf : "")].filter(Boolean).join(" · ");
      })
      .catch(function () { elCepInfo.style.color = "#caa"; elCepInfo.textContent = "Não foi possível buscar o CEP (você completa no checkout)."; });
  }

  function buildRef() {
    try {
      var qs = new URLSearchParams(location.search), parts = [];
      qs.forEach(function (v, k) { if (/^utm_/i.test(k) || k === "fbclid" || k === "gclid" || k === "ttclid") parts.push(k + "=" + v); });
      return parts.join("&");
    } catch (e) { return ""; }
  }

  function submitCheckout(ev) {
    ev.preventDefault();
    elErr.hidden = true;
    var name = elName.value.trim();
    var email = elEmail.value.trim();
    var phone = elPhone.value.trim();
    var cep = elCep.value.replace(/\D/g, "");
    if (name.length < 2) { return showErr("Informe seu nome completo."); }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { return showErr("Informe um e-mail válido."); }

    var items = arr().map(function (i) { return { variant_id: i.variant_id, quantity: i.qty }; });
    if (!items.length) return;

    var payload = { name: name, email: email, phone: phone, items: items, ref: buildRef() };
    // Meta CAPI matching: propagar fbp/fbc + URL para recuperarlos en el webhook order/paid.
    payload.meta = { fbp: getCookie("_fbp"), fbc: getCookie("_fbc"), event_source_url: (location.href || "").slice(0, 500), user_agent: (navigator.userAgent || "").slice(0, 400) };
    // Cupón de descuento (raspadinha): se guarda en ij_coupon y se aplica en el draft order.
    try { var _c = JSON.parse(localStorage.getItem("ij_coupon") || "null"); if (_c && _c.code) payload.coupon = String(_c.code); } catch (e) {}
    if (cep.length === 8) {
      payload.cep = cep;
      if (cepResolved) { payload.address = cepResolved.address; payload.city = cepResolved.city; payload.province = cepResolved.province; }
    }

    elSubmit.disabled = true; elSubmit.textContent = "Gerando pagamento…";
    fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (data) {
        if (data && data.ok && data.checkout_url) { try { localStorage.removeItem(STORE_KEY); } catch (e) {} window.location.href = data.checkout_url; return; }
        elSubmit.disabled = false; elSubmit.textContent = "Ir para o pagamento";
        showErr("Não foi possível abrir o pagamento. Tente novamente.");
      })
      .catch(function () { elSubmit.disabled = false; elSubmit.textContent = "Ir para o pagamento"; showErr("Falha de conexão. Verifique sua internet e tente novamente."); });
  }
  function showErr(m) { elErr.textContent = m; elErr.hidden = false; }

  /* ---------- wiring ---------- */
  function readBtn(btn) {
    var cats = (btn.getAttribute("data-category-ids") || "").split(",").map(function (s) { return Number(s.trim()); }).filter(function (x) { return x > 0; });
    return {
      variant_id: btn.getAttribute("data-variant-id"),
      product_id: btn.getAttribute("data-product-id"),
      category_ids: cats,
      name: btn.getAttribute("data-name"),
      price: btn.getAttribute("data-price"),
      image: btn.getAttribute("data-image")
    };
  }
  function wire() {
    document.getElementById("ijClose").addEventListener("click", closeDrawer);
    document.getElementById("ijKeep").addEventListener("click", function () {
      // "Continuar comprando" → va a la loja. Si ya estás en la loja, solo cierra el carrinho.
      if (/(^|\/)loja\.html$/i.test(location.pathname)) { closeDrawer(); }
      else { window.location.href = "loja.html"; }
    });
    ov.addEventListener("click", closeDrawer);
    checkoutBtn.addEventListener("click", openCheckout);
    document.getElementById("ijMx").addEventListener("click", closeCheckout);
    modal.addEventListener("click", function (e) { if (e.target === modal) closeCheckout(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") { if (!modal.hidden) closeCheckout(); else if (!ov.hidden) closeDrawer(); } });
    form.addEventListener("submit", submitCheckout);
    elCep.addEventListener("input", onCepInput);

    document.querySelectorAll("[data-ij-cart]").forEach(function (b) { b.addEventListener("click", function (e) { e.preventDefault(); openDrawer(); }); });
    document.querySelectorAll("[data-ij-add]").forEach(function (b) {
      b.addEventListener("click", function (e) { e.preventDefault(); addItem(readBtn(b), 1); openDrawer(); });
    });
    document.querySelectorAll("[data-ij-buy]").forEach(function (b) {
      b.addEventListener("click", function (e) { e.preventDefault(); addItem(readBtn(b), 1); openCheckout(); });
    });
  }

  function init() { injectUI(); grab(); wire(); updateCounts(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.IJStore = {
    addToCart: function (item, openIt) { addItem(item, item && item.qty); if (openIt !== false) openDrawer(); },
    buyNow: function (item) { addItem(item, item && item.qty); openCheckout(); },
    open: function () { openDrawer(); },
    count: count
  };
})();
