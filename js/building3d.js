/* building3d.js — renders 400H from the property's own unit polygons, plus
   surrounding streets + buildings from OpenStreetMap (data/context.json).
   Exposes: Building3D.init(container, buildingData, callbacks)
            Building3D.applyState({filterFn, availableSet, selectedUnit})
            Building3D.addContext(ctx), Building3D.setContextVisible(v), Building3D.resize() */

const Building3D = (() => {
  const FLOOR_H = 3.05;
  const COLORS = {
    base: 0xdfe3dd, match: 0x4e8a76, avail: 0xbfa05e,
    hover: 0x2f6b4f, selected: 0x24312d, podium: 0x39463f,
    ctxBuilding: 0xd3d8d2, road: 0xc9cec8, label: "#5a675f",
  };

  let scene, camera, renderer, raycaster, pointer;
  let meshes = [];
  let hovered = null;
  let cbs = {};
  let container;
  let needsRender = true;
  let contextGroup = null;

  const floorY = fl => fl * FLOOR_H;

  /* ---------- geometry helpers ---------- */

  function shapeFrom(points) {
    return new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  }

  // merge many non-indexed geometries (position+normal) into one
  function mergeGeos(geos) {
    let total = 0;
    const prepared = geos.map(g => {
      const ni = g.index ? g.toNonIndexed() : g;
      total += ni.attributes.position.count;
      return ni;
    });
    const pos = new Float32Array(total * 3);
    const nor = new Float32Array(total * 3);
    let off = 0;
    for (const g of prepared) {
      pos.set(g.attributes.position.array, off * 3);
      nor.set(g.attributes.normal.array, off * 3);
      off += g.attributes.position.count;
      g.dispose();
    }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    merged.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    return merged;
  }

  function makeUnitMesh(u) {
    const geo = new THREE.ExtrudeGeometry(shapeFrom(u.poly), { depth: FLOOR_H * 0.94, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: COLORS.base }));
    mesh.position.y = floorY(u.floor);
    mesh.userData.unit = u;
    return mesh;
  }

  function makePodium(outline) {
    if (!outline || outline.length < 4) return null;
    const geo = new THREE.ExtrudeGeometry(shapeFrom(outline), { depth: floorY(9) - 0.15, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
      color: COLORS.podium, transparent: true, opacity: 0.35 }));
  }

  /* ---------- surrounding context ---------- */

  function buildContextBuildings(list) {
    const geos = [];
    for (const b of list) {
      try {
        const g = new THREE.ExtrudeGeometry(shapeFrom(b.p), { depth: Math.max(2.5, b.h), bevelEnabled: false });
        g.rotateX(-Math.PI / 2);
        geos.push(g);
      } catch (_) { /* degenerate footprint — skip */ }
    }
    if (!geos.length) return null;
    return new THREE.Mesh(mergeGeos(geos), new THREE.MeshLambertMaterial({
      color: COLORS.ctxBuilding, transparent: true, opacity: 0.85 }));
  }

  function buildRoads(roads) {
    const tris = [];
    for (const r of roads) {
      const hw = (r.w || 6) / 2;
      for (let i = 0; i < r.p.length - 1; i++) {
        const [x1, y1] = r.p[i], [x2, y2] = r.p[i + 1];
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy);
        if (len < 0.5) continue;
        const px = -dy / len * hw, py = dx / len * hw;
        // ground plane: world (x, 0.06, -y)
        const a = [x1 + px, -(y1 + py)], b = [x1 - px, -(y1 - py)];
        const c = [x2 - px, -(y2 - py)], d = [x2 + px, -(y2 + py)];
        tris.push(a, b, c, a, c, d);
      }
    }
    const pos = new Float32Array(tris.length * 3);
    tris.forEach(([x, z], i) => { pos[i * 3] = x; pos[i * 3 + 1] = 0.06; pos[i * 3 + 2] = z; });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: COLORS.road }));
  }

  function labelTexture(text) {
    const c = document.createElement("canvas");
    c.width = 512; c.height = 96;
    const ctx = c.getContext("2d");
    ctx.font = "600 52px 'Saira Condensed', 'Arial Narrow', sans-serif";
    ctx.fillStyle = COLORS.label;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text.toUpperCase(), 256, 50);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    return tex;
  }

  function buildStreetLabels(roads) {
    const group = new THREE.Group();
    const placed = [];        // [{x, z}] to space labels out
    const MIN_GAP = 210, MAX_LABELS = 140;
    let count = 0;
    // longest segments first so labels prefer prominent stretches
    const named = roads.filter(r => r.n)
      .sort((a, b) => segLen(b) - segLen(a));
    for (const r of named) {
      if (count >= MAX_LABELS) break;
      const mid = midpoint(r);
      const [mx, my] = mid.pt;
      const wx = mx, wz = -my;
      if (placed.some(p => Math.hypot(p.x - wx, p.z - wz) < MIN_GAP)) continue;
      const w = Math.min(150, 26 + r.n.length * 6.5);
      const geo = new THREE.PlaneGeometry(w, w * 96 / 512);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        map: labelTexture(r.n), transparent: true, depthWrite: false }));
      let phi = Math.atan2(mid.dir[1], mid.dir[0]);
      if (Math.cos(phi) < 0) phi += Math.PI;   // keep text readable
      mesh.rotation.y = phi;
      mesh.position.set(wx, 0.4, wz);
      group.add(mesh);
      placed.push({ x: wx, z: wz });
      count++;
    }
    return group;
  }

  function segLen(r) {
    let s = 0;
    for (let i = 0; i < r.p.length - 1; i++)
      s += Math.hypot(r.p[i + 1][0] - r.p[i][0], r.p[i + 1][1] - r.p[i][1]);
    return s;
  }
  function midpoint(r) {
    const half = segLen(r) / 2;
    let acc = 0;
    for (let i = 0; i < r.p.length - 1; i++) {
      const d = Math.hypot(r.p[i + 1][0] - r.p[i][0], r.p[i + 1][1] - r.p[i][1]);
      if (acc + d >= half && d > 0) {
        const t = (half - acc) / d;
        return {
          pt: [r.p[i][0] + t * (r.p[i + 1][0] - r.p[i][0]), r.p[i][1] + t * (r.p[i + 1][1] - r.p[i][1])],
          dir: [(r.p[i + 1][0] - r.p[i][0]) / d, (r.p[i + 1][1] - r.p[i][1]) / d],
        };
      }
      acc += d;
    }
    return { pt: r.p[0], dir: [1, 0] };
  }

  function addContext(ctx) {
    if (!scene || contextGroup) return;
    contextGroup = new THREE.Group();
    const b = buildContextBuildings(ctx.buildings || []);
    if (b) contextGroup.add(b);
    if (ctx.roads && ctx.roads.length) {
      contextGroup.add(buildRoads(ctx.roads));
      contextGroup.add(buildStreetLabels(ctx.roads));
    }
    scene.add(contextGroup);
    needsRender = true;
  }

  function setContextVisible(v) {
    if (contextGroup) { contextGroup.visible = v; needsRender = true; }
  }

  /* ---------- orbit ---------- */

  function attachOrbit(dom) {
    const target = new THREE.Vector3(0, floorY(14), 0);
    let sph = new THREE.Spherical(140, Math.PI / 3.1, Math.PI / 5);
    let dragging = false, panning = false, px = 0, py = 0;
    function apply() {
      camera.position.setFromSpherical(sph).add(target);
      camera.lookAt(target);
      needsRender = true;
    }
    dom.addEventListener("pointerdown", e => {
      dragging = e.button === 0 && !e.shiftKey;
      panning = e.button === 2 || e.shiftKey;
      px = e.clientX; py = e.clientY;
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener("pointerup", () => { dragging = panning = false; });
    dom.addEventListener("pointermove", e => {
      const dx = e.clientX - px, dy = e.clientY - py;
      if (dragging) {
        sph.theta -= dx * 0.005;
        sph.phi = Math.min(Math.PI / 2.05, Math.max(0.12, sph.phi - dy * 0.005));
        px = e.clientX; py = e.clientY; apply();
      } else if (panning) {
        const scale = sph.radius * 0.0012;
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
        target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
        px = e.clientX; py = e.clientY; apply();
      }
    });
    dom.addEventListener("wheel", e => {
      e.preventDefault();
      sph.radius = Math.min(1700, Math.max(28, sph.radius * (1 + e.deltaY * 0.001)));
      apply();
    }, { passive: false });
    dom.addEventListener("contextmenu", e => e.preventDefault());
    apply();
  }

  /* ---------- picking ---------- */

  function pick(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(meshes.map(m => m.mesh), false);
    return hits.length ? hits[0].object : null;
  }

  /* ---------- init ---------- */

  function init(el, building, callbacks) {
    container = el; cbs = callbacks || {};
    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xf1f3ef, 550, 2400);
    camera = new THREE.PerspectiveCamera(45, el.clientWidth / el.clientHeight, 0.5, 5000);
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    el.appendChild(renderer.domElement);
    raycaster = new THREE.Raycaster();
    pointer = new THREE.Vector2();

    scene.add(new THREE.HemisphereLight(0xffffff, 0x99a59d, 1.0));
    const sun = new THREE.DirectionalLight(0xfff4de, 1.1);
    sun.position.set(80, 160, 60);
    scene.add(sun);

    const podium = makePodium(building.podium);
    if (podium) scene.add(podium);
    for (const u of building.units) {
      const mesh = makeUnitMesh(u);
      scene.add(mesh);
      meshes.push({ mesh, unit: u });
    }

    const plate = new THREE.Mesh(
      new THREE.CircleGeometry(2000, 64),
      new THREE.MeshBasicMaterial({ color: 0xeef0ec }));
    plate.rotation.x = -Math.PI / 2; plate.position.y = -0.2;
    scene.add(plate);

    attachOrbit(renderer.domElement);

    renderer.domElement.addEventListener("pointermove", e => {
      const hit = pick(e);
      if (hit !== hovered) {
        hovered = hit;
        renderer.domElement.style.cursor = hit ? "pointer" : "grab";
        needsRender = true;
      }
    });
    renderer.domElement.addEventListener("click", e => {
      const hit = pick(e);
      if (hit && cbs.onSelect) cbs.onSelect(hit.userData.unit);
    });

    window.addEventListener("resize", resize);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    (function loop() {
      requestAnimationFrame(loop);
      if (needsRender || !reduced) {
        recolor();
        renderer.render(scene, camera);
        needsRender = false;
      }
    })();
  }

  function resize() {
    if (!container || !renderer) return;
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    needsRender = true;
  }

  /* ---------- state / coloring ---------- */

  let state = { filterFn: () => true, availableSet: new Set(), selectedUnit: null };
  function applyState(next) {
    state = { ...state, ...next };
    needsRender = true;
  }

  function recolor() {
    for (const { mesh, unit } of meshes) {
      const m = mesh.material;
      let c = COLORS.base, op = 0.28;
      const matches = state.filterFn(unit);
      if (matches) { c = COLORS.match; op = 0.92; }
      if (matches && state.availableSet.has(unit.unit)) { c = COLORS.avail; op = 1.0; }
      if (hovered === mesh) { c = COLORS.hover; op = 1.0; }
      if (state.selectedUnit === unit.unit) { c = COLORS.selected; op = 1.0; }
      m.color.setHex(c);
      m.transparent = op < 1;
      m.opacity = op;
    }
  }

  return { init, applyState, addContext, setContextVisible, resize };
})();
