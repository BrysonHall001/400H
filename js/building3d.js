/* building3d.js — renders 400H from the property's own unit polygons.
   Exposes: Building3D.init(container, buildingData, callbacks)
            Building3D.applyState({filterFn, availableSet, selectedUnit}) */

const Building3D = (() => {
  const FLOOR_H = 3.05;           // meters per floor
  const COLORS = {
    base: 0xdfe3dd,               // quiet glass gray
    match: 0x4e8a76,              // filter match
    avail: 0xbfa05e,              // available (champagne)
    hover: 0x2f6b4f,
    selected: 0x24312d,
    podium: 0x39463f,
  };

  let scene, camera, renderer, raycaster, pointer;
  let meshes = [];                // {mesh, unit}
  let hovered = null, selected = null;
  let cbs = {};
  let container;
  let needsRender = true;

  function floorY(fl) { return fl * FLOOR_H; }

  function makeUnitMesh(u) {
    const shape = new THREE.Shape(u.poly.map(([x, y]) => new THREE.Vector2(x, y)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: FLOOR_H * 0.94, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2); // extrusion becomes +Y, north becomes -Z
    const mat = new THREE.MeshLambertMaterial({ color: COLORS.base });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = floorY(u.floor);
    mesh.userData.unit = u;
    return mesh;
  }

  function makePodium(outline) {
    if (!outline || outline.length < 4) return null;
    const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: floorY(9) - 0.15, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
      color: COLORS.podium, transparent: true, opacity: 0.35 }));
    mesh.position.y = 0;
    return mesh;
  }

  /* minimal orbit: drag to rotate, wheel to zoom, right-drag/two-finger to pan */
  function attachOrbit(dom) {
    const target = new THREE.Vector3(0, floorY(14), 0);
    let sph = new THREE.Spherical(120, Math.PI / 3.1, Math.PI / 5);
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
        sph.phi = Math.min(Math.PI / 2.05, Math.max(0.15, sph.phi - dy * 0.005));
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
      sph.radius = Math.min(400, Math.max(30, sph.radius * (1 + e.deltaY * 0.001)));
      apply();
    }, { passive: false });
    dom.addEventListener("contextmenu", e => e.preventDefault());
    apply();
  }

  function pick(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(meshes.map(m => m.mesh), false);
    return hits.length ? hits[0].object : null;
  }

  function init(el, building, callbacks) {
    container = el; cbs = callbacks || {};
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, el.clientWidth / el.clientHeight, 0.5, 2000);
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

    // ground shadow-ish plate
    const plate = new THREE.Mesh(
      new THREE.CircleGeometry(140, 48),
      new THREE.MeshBasicMaterial({ color: 0xe9ece7 }));
    plate.rotation.x = -Math.PI / 2; plate.position.y = -0.2;
    scene.add(plate);

    attachOrbit(renderer.domElement);

    renderer.domElement.addEventListener("pointermove", e => {
      const hit = pick(e);
      if (hit !== hovered) {
        hovered = hit;
        renderer.domElement.style.cursor = hit ? "pointer" : "grab";
        if (cbs.onHover) cbs.onHover(hit ? hit.userData.unit : null);
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
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    needsRender = true;
  }

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

  return { init, applyState, resize };
})();
