// Progressive enhancement only. Every action also works with plain forms.
(function () {
  'use strict';
  var R = 6371008.8;
  function toLngLat(svg, evt) {
    var pt = svg.createSVGPoint(); pt.x = evt.clientX; pt.y = evt.clientY;
    var m = svg.getScreenCTM(); if (!m) return null;
    var p = pt.matrixTransform(m.inverse());
    var lng0 = parseFloat(svg.dataset.lng), lat0 = parseFloat(svg.dataset.lat);
    var k = Math.cos(lat0 * Math.PI / 180);
    return [lng0 + (p.x / (R * k)) * 180 / Math.PI, lat0 + (-p.y / R) * 180 / Math.PI];
  }

  // Move the pin: clicking the map fills hidden inputs and shows a marker.
  document.querySelectorAll('svg[data-mode="pin"]').forEach(function (svg) {
    var form = document.getElementById('pin-form');
    svg.addEventListener('click', function (e) {
      var ll = toLngLat(svg, e); if (!ll || !form) return;
      form.querySelector('[name=lng]').value = ll[0].toFixed(6);
      form.querySelector('[name=lat]').value = ll[1].toFixed(6);
      form.hidden = false;
      var note = document.getElementById('pin-note'); if (note) note.textContent = 'New pin chosen. Save it to measure distances from there.';
    });
  });

  // Draw a polygon: click to add corners, then submit.
  document.querySelectorAll('svg[data-mode="draw"]').forEach(function (svg) {
    var form = document.getElementById('draw-form'); if (!form) return;
    var input = form.querySelector('[name=coords]');
    var count = document.getElementById('draw-count');
    var pts = [];
    var ns = 'http://www.w3.org/2000/svg';
    var line = document.createElementNS(ns, 'polyline');
    line.setAttribute('class', 'm-draw'); line.setAttribute('fill', 'none');
    var vb = svg.viewBox.baseVal; line.setAttribute('stroke-width', String(vb.width / 170));
    svg.appendChild(line);
    var raw = [];
    svg.addEventListener('click', function (e) {
      var ll = toLngLat(svg, e); if (!ll) return;
      pts.push(ll);
      var pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
      var p = pt.matrixTransform(svg.getScreenCTM().inverse()); raw.push(p.x + ',' + p.y);
      line.setAttribute('points', raw.concat(raw.length > 2 ? [raw[0]] : []).join(' '));
      input.value = JSON.stringify(pts);
      if (count) count.textContent = pts.length + (pts.length === 1 ? ' corner' : ' corners');
      form.querySelector('button[type=submit]').disabled = pts.length < 3;
    });
    var clear = document.getElementById('draw-clear');
    if (clear) clear.addEventListener('click', function () { pts = []; raw = []; line.setAttribute('points', ''); input.value = ''; if (count) count.textContent = '0 corners'; });
  });

  // Auto-submit simple choices (radius, preset) while keeping the submit buttons for no-JS use.
  document.querySelectorAll('[data-autosubmit]').forEach(function (el) {
    el.addEventListener('change', function () { el.form && el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit(); });
  });

  // Show the description of the selected research depth.
  document.querySelectorAll('select[data-desc-target]').forEach(function (sel) {
    var out = document.getElementById(sel.dataset.descTarget);
    sel.addEventListener('change', function () { var o = sel.options[sel.selectedIndex]; if (out && o) out.textContent = o.dataset.desc || ''; });
  });
  // Fill refinement text from suggestion chips.
  document.querySelectorAll('[data-fill]').forEach(function (b) {
    b.addEventListener('click', function () { var t = document.getElementById(b.dataset.target); if (t) { t.value = b.dataset.fill; t.focus(); } });
  });
})();
