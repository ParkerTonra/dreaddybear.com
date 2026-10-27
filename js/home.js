// Draws the landing page from window.SITE (js/home-data.js): hero, music section, card grid.
(function () {
    var site = window.SITE;
    if (!site) return;

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text) n.textContent = text;
        return n;
    }

    function isExternal(href) { return /^https?:\/\//.test(href); }

    function link(href, cls, text) {
        var a = el('a', cls, text);
        a.href = href;
        if (isExternal(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
        return a;
    }

    function icon(name) {
        var i = el('i', 'fa fa-' + name);
        i.setAttribute('aria-hidden', 'true');
        return i;
    }

    // ---------- hero ----------
    var hero = document.getElementById('hero');
    var stopMedia = null;

    function heroMedia(media, box) {
        if (stopMedia) { stopMedia(); stopMedia = null; }
        box.textContent = '';
        if (!media) return;
        if (media.type === 'ants') {
            var c = el('canvas', 'hero__canvas');
            c.setAttribute('aria-hidden', 'true');
            box.appendChild(c);
            stopMedia = antCanvas(c);
        } else if (media.type === 'image') {
            var img = el('img');
            img.src = media.src;
            img.alt = media.alt || '';
            box.appendChild(img);
        } else if (media.type === 'video') {
            var v = el('video');
            v.src = media.src;
            v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
            box.appendChild(v);
        } else if (media.type === 'embed') {
            var f = el('iframe');
            f.src = media.src;
            f.title = media.title || 'Featured';
            f.loading = 'lazy';
            f.allow = 'autoplay; fullscreen';
            box.appendChild(f);
        }
    }

    function showFeatured(i) {
        var item = site.featured[i];
        var text = hero.querySelector('.hero__text');
        text.textContent = '';
        if (item.eyebrow) text.appendChild(el('p', 'eyebrow', item.eyebrow));
        text.appendChild(el('h1', null, item.title));
        if (item.blurb) text.appendChild(el('p', 'hero__blurb', item.blurb));
        var actions = el('div', 'hero__actions');
        (item.actions || []).forEach(function (act, k) {
            actions.appendChild(link(act.href, k === 0 ? 'btn' : 'btn btn--ghost', act.label));
        });
        text.appendChild(actions);
        heroMedia(item.media, hero.querySelector('.hero__media'));
        hero.querySelectorAll('.hero__tab').forEach(function (t, k) {
            t.setAttribute('aria-selected', k === i ? 'true' : 'false');
        });
    }

    if (hero && site.featured && site.featured.length) {
        hero.appendChild(el('div', 'hero__text'));
        hero.appendChild(el('div', 'hero__media'));
        if (site.featured.length > 1) {
            var tabs = el('div', 'hero__tabs');
            tabs.setAttribute('role', 'tablist');
            site.featured.forEach(function (item, i) {
                var b = el('button', 'hero__tab', item.title);
                b.type = 'button';
                b.setAttribute('role', 'tab');
                b.addEventListener('click', function () { showFeatured(i); });
                tabs.appendChild(b);
            });
            hero.appendChild(tabs);
        }
        showFeatured(0);
    }

    // ---------- music ----------
    var music = document.getElementById('music');
    if (music && site.music) {
        var m = site.music;
        var head = el('div', 'section__head');
        if (m.eyebrow) head.appendChild(el('p', 'eyebrow', m.eyebrow));
        head.appendChild(el('h2', null, m.title));
        music.appendChild(head);
        var body = el('div', 'card music');
        if (m.player) {
            var f = el('iframe', 'music__player');
            f.title = m.title;
            f.src = m.player;
            f.loading = 'lazy';
            f.allow = 'autoplay';
            body.appendChild(f);
        }
        var links = el('ul', 'listen');
        (m.links || []).forEach(function (l) {
            var li = el('li');
            var a = link(l.href, 'listen__link');
            a.appendChild(icon(l.icon));
            a.appendChild(el('span', null, l.label));
            li.appendChild(a);
            links.appendChild(li);
        });
        body.appendChild(links);
        music.appendChild(body);
    }

    // ---------- cards ----------
    var grid = document.getElementById('cards');
    if (grid && site.cards) {
        site.cards.forEach(function (c) {
            var a = link(c.href, 'tile');
            var badge = el('span', 'tile__icon');
            badge.appendChild(icon(c.icon));
            a.appendChild(badge);
            a.appendChild(el('h3', null, c.title));
            if (c.text) a.appendChild(el('p', null, c.text));
            grid.appendChild(a);
        });
    }

    // ---------- ant canvas ----------
    // Little ants wander, trail back to a hill in the middle, and scatter from the pointer.
    function antCanvas(canvas) {
        var ctx = canvas.getContext('2d');
        var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        var w = 0, h = 0, raf = 0, pointer = null;
        var ants = [];
        var seed = 7;
        function rand() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }

        function colors() {
            var cs = getComputedStyle(document.documentElement);
            return {
                ant: cs.getPropertyValue('--text').trim() || '#15162b',
                hill: cs.getPropertyValue('--accent').trim() || '#4f46e5',
                ground: cs.getPropertyValue('--surface-2').trim() || '#eeeef8'
            };
        }
        var col = colors();

        function resize() {
            var r = canvas.getBoundingClientRect();
            w = r.width; h = r.height;
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            var want = Math.round(Math.max(18, Math.min(60, w * h / 4000)));
            while (ants.length < want) {
                ants.push({ x: rand() * w, y: rand() * h, a: rand() * Math.PI * 2, s: 0.5 + rand() * 0.7, step: rand() * 10, home: rand() < 0.5 });
            }
            ants.length = want;
        }

        function drawAnt(t) {
            var leg = Math.sin(t.step) * 2.2;
            ctx.save();
            ctx.translate(t.x, t.y);
            ctx.rotate(t.a);
            ctx.strokeStyle = col.ant;
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (var k = -1; k <= 1; k++) {
                var off = (k % 2 === 0 ? leg : -leg);
                ctx.moveTo(k * 2.2, 0); ctx.lineTo(k * 2.2 + off, -4.2);
                ctx.moveTo(k * 2.2, 0); ctx.lineTo(k * 2.2 - off, 4.2);
            }
            ctx.stroke();
            ctx.fillStyle = col.ant;
            ctx.beginPath(); ctx.ellipse(-3.6, 0, 2.6, 1.9, 0, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.ellipse(0, 0, 1.7, 1.3, 0, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.arc(2.8, 0, 1.5, 0, Math.PI * 2); ctx.fill();
            ctx.restore();
        }

        function frame() {
            var hx = w / 2, hy = h * 0.62;
            ctx.clearRect(0, 0, w, h);
            ctx.fillStyle = col.hill;
            ctx.globalAlpha = 0.18;
            ctx.beginPath(); ctx.ellipse(hx, hy, 46, 18, 0, 0, Math.PI * 2); ctx.fill();
            ctx.globalAlpha = 1;
            ctx.beginPath(); ctx.ellipse(hx, hy, 9, 4, 0, 0, Math.PI * 2); ctx.fill();

            ants.forEach(function (t) {
                var want = t.a + (rand() - 0.5) * 0.5;
                if (t.home) {
                    var toHill = Math.atan2(hy - t.y, hx - t.x);
                    want += angleDiff(toHill, want) * 0.08;
                    if (Math.hypot(hx - t.x, hy - t.y) < 10) { t.home = false; t.a += Math.PI; }
                } else if (rand() < 0.004) {
                    t.home = true;
                }
                var speed = t.s;
                if (pointer) {
                    var dx = t.x - pointer.x, dy = t.y - pointer.y, d = Math.hypot(dx, dy);
                    if (d < 70) { want += angleDiff(Math.atan2(dy, dx), want) * 0.35; speed *= 2.6; }
                }
                t.a = want;
                t.x += Math.cos(t.a) * speed;
                t.y += Math.sin(t.a) * speed;
                t.step += speed * 0.9;
                if (t.x < -8) t.x = w + 8; else if (t.x > w + 8) t.x = -8;
                if (t.y < -8) t.y = h + 8; else if (t.y > h + 8) t.y = -8;
                drawAnt(t);
            });
            if (!still) raf = requestAnimationFrame(frame);
        }

        function angleDiff(a, b) {
            var d = a - b;
            while (d > Math.PI) d -= Math.PI * 2;
            while (d < -Math.PI) d += Math.PI * 2;
            return d;
        }

        function onMove(e) {
            var r = canvas.getBoundingClientRect();
            pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
        }
        function onLeave() { pointer = null; }
        var scheme = window.matchMedia('(prefers-color-scheme: dark)');
        function onScheme() { col = colors(); if (still) frame(); }

        resize();
        if (still) { for (var i = 0; i < 120; i++) frame(); }
        frame();
        window.addEventListener('resize', resize);
        canvas.addEventListener('pointermove', onMove);
        canvas.addEventListener('pointerleave', onLeave);
        if (scheme.addEventListener) scheme.addEventListener('change', onScheme);

        return function stop() {
            cancelAnimationFrame(raf);
            window.removeEventListener('resize', resize);
            if (scheme.removeEventListener) scheme.removeEventListener('change', onScheme);
        };
    }
})();
