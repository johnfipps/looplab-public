const profiles = [
  { shape: 'Chicken', x: 348, depth: .72, size: 1.08, travel: 113, rise: 49, lean: 19, airBeats: .82, flipEvery: 4, spin: 360 },
  { shape: 'Apple', x: 105, depth: .64, size: .95, travel: 68, rise: 22, lean: 22, airBeats: .46 },
  { shape: 'Carrot', x: 232, depth: .31, size: .91, travel: 112, rise: 57, lean: 30, airBeats: .86, flipEvery: 3, spin: 360 },
  { shape: 'Berry', x: 300, depth: .91, size: .76, travel: 86, rise: 42, lean: 26, airBeats: .42, flipEvery: 3, spin: 360 },
  { shape: 'Avocado', x: 435, depth: .39, size: 1.05, travel: 78, rise: 9, lean: 16, airBeats: .48 },
  { shape: 'Orange', x: 502, depth: .83, size: .91, travel: 119, rise: 59, lean: 33, airBeats: .8, flipEvery: 2, spin: 360 },
  { shape: 'Broccoli', x: 615, depth: .38, size: 1.08, travel: 70, rise: 15, lean: 13, airBeats: .55 },
  { shape: 'Banana', x: 686, depth: .78, size: .88, travel: 141, rise: 73, lean: 29, airBeats: .94, flipEvery: 3, spin: 360 }
];
const svg = (tag) => document.createElementNS('http://www.w3.org/2000/svg', tag);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const ease = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');

export function createDanceStage(dialog) {
  const layer = dialog.querySelector('#stageDancers');
  const stage = layer.ownerSVGElement;
  const shadowLayer = dialog.querySelector('#stageShadows');
  const beams = [...dialog.querySelectorAll('.stageBeams path')];
  const legend = [...dialog.querySelectorAll('.chickenKitLegend li')];
  const dancers = profiles.map((profile, index) => {
    const dancer = svg('use');
    dancer.setAttribute('href', '#dance' + profile.shape);
    dancer.setAttribute('tabindex', '0');
    dancer.setAttribute('role', 'button');
    dancer.setAttribute('aria-label', 'Make ' + legend[index].textContent + ' dance');
    const shadow = svg('ellipse');
    shadow.setAttribute('rx', '30');
    shadow.setAttribute('ry', '7');
    shadow.setAttribute('fill', '#120e1d');
    layer.append(dancer);
    shadowLayer.append(shadow);
    return { profile, dancer, shadow, label: legend[index], x: profile.x, depth: profile.depth, hits: 0, travel: null, air: null };
  });

  let frame = 0;
  let order = '';
  let drag = null;
  function draw(now) {
    frame = 0;
    if (!dialog.open) return;
    let moving = false;
    for (const d of dancers) {
      let tilt = 0, height = 0, stretch = 1;
      if (d.travel) {
        const { start, duration, fromX, fromDepth, toX, toDepth, lean } = d.travel;
        const progress = clamp((now - start) / duration, 0, 1);
        const glide = ease(progress);
        d.x = lerp(fromX, toX, glide);
        d.depth = lerp(fromDepth, toDepth, glide);
        tilt = Math.sin(Math.PI * progress) * lean;
        if (progress === 1) d.travel = null;
      }
      if (d.air) {
        const { start, duration, rise, spin } = d.air;
        const progress = clamp((now - start) / duration, 0, 1);
        height = 4 * rise * progress * (1 - progress);
        const tuck = Math.sin(Math.PI * progress);
        stretch = 1 - (spin ? .12 : -.06) * tuck;
        tilt += spin * ease(progress);
        if (progress === 1) d.air = null;
      }
      const floor = 221 + d.depth * 161;
      const scale = (.71 + d.depth * .39) * d.profile.size;
      d.dancer.setAttribute('transform',
        `translate(${d.x} ${floor - height}) scale(${scale}) rotate(${tilt} 0 -44) scale(1 ${stretch})`);
      d.shadow.setAttribute('transform', `translate(${d.x} ${floor + 1}) scale(${scale * (1 - height / 240)})`);
      d.shadow.setAttribute('opacity', String(.48 - height / 210));
      moving ||= !!(d.travel || d.air);
    }
    // Sort by foot position on the floor so a crossing dancer can pass in front or behind.
    const depthOrder = [...dancers].sort((a, b) => a.depth - b.depth);
    const key = depthOrder.map(d => d.profile.shape).join(' ');
    if (key !== order) {
      order = key;
      const focused = document.activeElement;
      for (const d of depthOrder) layer.append(d.dancer);
      if (layer.contains(focused) && focused !== document.activeElement) focused.focus({ preventScroll: true });
    }
    if (moving) frame = requestAnimationFrame(draw);
  }

  function flash(element, frames, duration) {
    element.getAnimations().forEach(animation => animation.cancel());
    element.animate(frames, { duration, easing: 'ease-out' });
  }

  function hit(index, velocity, bpm) {
    const d = dancers[index];
    if (!dialog.open || !d) return;
    const beat = 60000 / bpm;
    flash(d.label, [{ color: '#fff1a4', backgroundColor: '#ffffff26' }, { color: '', backgroundColor: '' }], Math.min(beat * .75, 400));
    if (motionPreference.matches || (drag?.dancer === d && drag.moved)) return;
    const now = performance.now();
    const p = d.profile;
    const hit = ++d.hits;
    const direction = (hit + index) % 2 ? 1 : -1;
    const accent = .55 + .45 * velocity;
    const depth = p.depth + .34 * Math.sin(hit * 1.27 + index);
    d.travel = {
      start: now, duration: clamp(beat * .8, 165, 780),
      fromX: d.x, fromDepth: d.depth,
      toX: clamp(p.x + direction * p.travel * accent, 60, 720),
      toDepth: clamp(depth, .1, .95), lean: direction * p.lean * accent
    };
    if (!d.air) {
      const spin = p.flipEvery && hit % p.flipEvery === 0 ? p.spin * direction : 0;
      d.air = { start: now, duration: clamp(beat * p.airBeats, 160, 800), rise: p.rise * accent, spin };
    }
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function stagePoint(event) {
    const matrix = stage.getScreenCTM();
    return matrix && new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  }

  stage.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    const index = dancers.findIndex(d => d.dancer === event.target.closest('use'));
    if (index < 0) return;
    const start = stagePoint(event);
    if (!start) return;
    const dancer = dancers[index];
    drag = { id: event.pointerId, index, dancer, start, x: dancer.x, depth: dancer.depth, moved: false };
    stage.setPointerCapture(event.pointerId);
  });

  stage.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    const point = stagePoint(event);
    if (!point) return;
    const dx = point.x - drag.start.x, dy = point.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    const d = drag.dancer;
    drag.moved = true;
    d.dancer.classList.add('isDragging');
    d.travel = d.air = null;
    d.x = clamp(drag.x + dx, 60, 740);
    d.depth = clamp(drag.depth + dy / 161, .08, .98);
    if (!frame) frame = requestAnimationFrame(draw);
  });

  function finishDrag(event) {
    if (drag?.id !== event.pointerId) return;
    const { id, index, dancer, moved } = drag;
    drag = null;
    dancer.dancer.classList.remove('isDragging');
    if (stage.hasPointerCapture(id)) stage.releasePointerCapture(id);
    if (event.type !== 'pointerup') return;
    if (!moved) {
      hit(index, 1, 120);
    } else if (!motionPreference.matches) {
      dancer.air = { start: performance.now(), duration: 290, rise: Math.min(20, dancer.profile.rise), spin: 0 };
      if (!frame) frame = requestAnimationFrame(draw);
    }
  }

  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    stage.addEventListener(type, finishDrag);
  }
  dancers.forEach(({ dancer }, index) => {
    dancer.addEventListener('keydown', event => {
      if (!['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      if (!event.repeat) hit(index, 1, 120);
    });
  });

  return {
    reset() {
      cancelAnimationFrame(frame);
      if (drag) {
        const { id, dancer } = drag;
        drag = null;
        dancer.dancer.classList.remove('isDragging');
        if (stage.hasPointerCapture(id)) stage.releasePointerCapture(id);
      }
      for (const d of dancers) {
        d.x = d.profile.x;
        d.depth = d.profile.depth;
        d.hits = 0;
        d.travel = d.air = null;
      }
      draw(performance.now());
    },
    hit,
    beat(index, bpm) {
      if (!dialog.open) return;
      const beat = 60000 / bpm;
      beams.forEach((beam, i) => {
        const accent = (index + i) % beams.length === 0;
        const peak = motionPreference.matches ? (accent ? .17 : .11) : (accent ? .39 : .19);
        flash(beam, [{ opacity: peak }, { opacity: .08 }], beat * .92);
      });
    }
  };
}
