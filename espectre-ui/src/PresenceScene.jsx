import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

const STATES = {
  PRESENT_MOVING: ['Movement detected', 'The sensor is detecting sustained motion.', '#738ab4'],
  PRESENT_STATIONARY: ['Presence detected', 'Presence is retained with little current movement.', '#6f9d91'],
  POSSIBLE_EMPTY: ['Possibly empty', 'No sustained motion. Occupancy is uncertain.', '#94a3b8'],
  UNKNOWN: ['Waiting for signal', 'A healthy sensor connection is needed to show presence.', '#94a3b8'],
};

export default function PresenceScene({ state, ready, theme = 'dark', activity = 'ACTIVITY_UNKNOWN', motionScore, sensorStatus }) {
  const host = useRef(null);
  const current = useRef('UNKNOWN');
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const routerLabel = useRef(null);
  const sensorLabel = useRef(null);
  const [unavailable, setUnavailable] = useState(false);
  const effective = ready && STATES[state] ? state : 'UNKNOWN';
  current.current = effective;
  const [label, description, color] = STATES[effective];

  useEffect(() => {
    const container = host.current;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setUnavailable(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 50);
    const target = new THREE.Vector3(0, 0.7, 0);
    const direction = new THREE.Vector3(6, 5.2, 7.5).normalize();
    const ambient = new THREE.HemisphereLight(0xe7efff, 0x535663, 2.1);
    scene.add(ambient);
    const light = new THREE.DirectionalLight(0xffefd9, 3.2);
    light.position.set(-3, 7, 4);
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    Object.assign(light.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 0.5, far: 20 });
    light.shadow.normalBias = 0.035;
    light.shadow.bias = -0.0001;
    light.shadow.radius = 4;
    scene.add(light);
    const fillLight = new THREE.DirectionalLight(0xc9d9ec, 1.1);
    fillLight.position.set(4, 3, -2);
    scene.add(fillLight);
    const materialsByTheme = [];
    function surface(lightColor, darkColor, roughness = 0.8) {
      const mat = new THREE.MeshStandardMaterial({ color: lightColor, roughness });
      materialsByTheme.push([mat, lightColor, darkColor]);
      return mat;
    }
    const floorMaterial = surface('#d6d0c4', '#343b43');
    const wallMaterial = surface('#e9e6df', '#444c57');
    const edgeMaterial = surface('#b5ad9d', '#252d37');
    const fabric = surface('#aaa99c', '#667477');
    const wood = surface('#b59a7a', '#716454');
    const white = surface('#f3f0e9', '#aeb7bd');
    const leaves = surface('#637b65', '#526c60');
    function mesh(geometry, mat, x, y, z, parent = scene) {
      const object = new THREE.Mesh(geometry, mat);
      object.position.set(x, y, z);
      object.castShadow = true;
      object.receiveShadow = true;
      parent.add(object);
      return object;
    }
    function box(w, h, d, mat, x, y, z, parent = scene) {
      return mesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z, parent);
    }
    box(5.4, 0.16, 4.4, edgeMaterial, 0, -0.12, 0);
    box(5.3, 0.06, 4.3, floorMaterial, 0, -0.02, 0);
    box(5.4, 2.5, 0.1, wallMaterial, 0, 1.2, -2.2);
    box(0.1, 2.5, 4.4, wallMaterial, -2.7, 1.2, 0);
    box(5.3, 0.08, 0.035, white, 0, 0.07, -2.13);
    box(0.035, 0.08, 4.3, white, -2.63, 0.07, 0);
    // Window recess and mullions provide architectural depth without a busy backdrop.
    const glass = surface('#bbcbd0', '#506675', 0.25);
    box(0.04, 1.32, 2.1, white, -2.63, 1.55, -0.25);
    box(0.045, 1.19, 1.94, glass, -2.60, 1.55, -0.25);
    box(0.05, 1.2, 0.045, white, -2.57, 1.55, -0.25);
    box(0.05, 0.045, 1.94, white, -2.57, 1.55, -0.25);
    // Low furniture preserves the silhouette and keeps the room legible.
    box(1.8, 0.24, 0.72, fabric, -1.25, 0.29, -1.48);
    box(1.8, 0.63, 0.18, fabric, -1.25, 0.53, -1.82);
    for (const x of [-2.1, -0.4]) box(0.15, 0.43, 0.78, fabric, x, 0.41, -1.48);
    const rug = surface('#c0b9ab', '#465059');
    box(2.4, 0.018, 2.05, rug, 0.15, 0.024, 0.4);
    mesh(new THREE.CylinderGeometry(0.43, 0.43, 0.06, 40), wood, -1.5, 0.48, 0.25);
    mesh(new THREE.CylinderGeometry(0.12, 0.19, 0.43, 24), edgeMaterial, -1.5, 0.235, 0.25);
    box(0.85, 0.65, 0.48, wood, 1.7, 0.325, -1.77);
    mesh(new THREE.CylinderGeometry(0.18, 0.14, 0.3, 24), white, -2.12, 0.15, 1.5);
    for (let i = 0; i < 5; i++) {
      const leaf = mesh(new THREE.SphereGeometry(1, 12, 12), leaves, -2.12 + Math.sin(i * 2) * 0.13, 0.55 + i * 0.035, 1.5 + Math.cos(i * 2) * 0.1);
      leaf.scale.set(0.1, 0.33, 0.09);
      leaf.rotation.z = Math.sin(i * 2) * 0.55;
    }
    const deviceMaterial = surface('#f4f6f7', '#bbc4ce', 0.4);
    box(0.37, 0.065, 0.24, deviceMaterial, 1.7, 0.69, -1.77);
    for (const x of [1.56, 1.84]) box(0.025, 0.23, 0.025, edgeMaterial, x, 0.82, -1.84);
    box(0.18, 0.25, 0.07, deviceMaterial, -2.6, 1.05, 1.55);
    const led = new THREE.MeshBasicMaterial({ color: '#779c90' });
    mesh(new THREE.SphereGeometry(0.018, 8, 8), led, -2.55, 1.09, 1.58);
    const routerPosition = new THREE.Vector3(1.7, 1.05, -1.77);
    const sensorPosition = new THREE.Vector3(-2.5, 1.35, 1.55);
    const material = new THREE.MeshStandardMaterial({ color: '#738ab4', roughness: 0.6, metalness: 0.08, transparent: true, opacity: 0 });
    const person = new THREE.Group();
    person.position.set(0.35, 0.04, 0.4);
    person.rotation.y = 0.3;
    scene.add(person);
    // A tailored torso, neck, oval head, articulated limbs and feet form a continuous silhouette.
    const profile = [[0, 0], [0.14, 0], [0.18, 0.08], [0.16, 0.25], [0.23, 0.47], [0.21, 0.53], [0.09, 0.57], [0, 0.57]];
    const torso = mesh(new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 32), material, 0, 0.87, 0, person);
    torso.scale.z = 0.68;
    mesh(new THREE.CylinderGeometry(0.075, 0.08, 0.14, 16), material, 0, 1.47, 0, person);
    const head = mesh(new THREE.SphereGeometry(0.16, 24, 20), material, 0, 1.66, 0, person);
    head.scale.set(0.87, 1.15, 0.94);
    function limb(x, y, length, radius) {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      person.add(pivot);
      mesh(new THREE.CapsuleGeometry(radius, length, 8, 16), material, 0, -length / 2, 0, pivot);
      return pivot;
    }
    const arms = [limb(-0.24, 1.34, 0.49, 0.065), limb(0.24, 1.34, 0.49, 0.065)];
    arms[0].rotation.z = -0.08;
    arms[1].rotation.z = 0.08;
    const legs = [limb(-0.095, 0.88, 0.69, 0.082), limb(0.095, 0.88, 0.69, 0.082)];
    legs.forEach(leg => {
      const foot = mesh(new THREE.SphereGeometry(1, 16, 12), material, 0, -0.79, 0.055, leg);
      foot.scale.set(0.084, 0.065, 0.15);
    });
    const ringMaterial = new THREE.MeshBasicMaterial({ color: '#738ab4', transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
    const ring = mesh(new THREE.RingGeometry(0.58, 0.595, 64), ringMaterial, 0.35, 0.05, 0.4);
    ring.rotation.x = -Math.PI / 2;
    ring.castShadow = false;
    const pathMaterial = new THREE.LineDashedMaterial({ color: '#738ab4', transparent: true, opacity: 0, dashSize: 0.08, gapSize: 0.11 });
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(-0.5, 0.052, 1.3), new THREE.Vector3(0.25, 0.052, 1.1), new THREE.Vector3(1.1, 0.052, 0.3)]);
    const trail = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(60)), pathMaterial);
    trail.computeLineDistances();
    scene.add(trail);
    const colorTarget = new THREE.Color();
    let lastTheme;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let visible = true;
    let frame;
    let previous = 0;
    let phase = 0;
    const resize = new ResizeObserver(() => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      const distance = 3.8 / Math.sin(THREE.MathUtils.degToRad(18)) * Math.max(1, 1.25 / camera.aspect);
      camera.position.copy(target).addScaledVector(direction, distance);
      camera.lookAt(target);
      camera.updateProjectionMatrix();
    });
    resize.observe(container);
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
    observer.observe(container);
    function animate(time) {
      frame = requestAnimationFrame(animate);
      const delta = Math.min((time - previous) / 1000, 0.05);
      previous = time;
      if (!visible || document.hidden) return;
      const status = current.current;
      const moving = status === 'PRESENT_MOVING';
      const blend = reducedMotion.matches ? 1 : 1 - Math.exp(-delta * 7);
      const occupied = moving || status === 'PRESENT_STATIONARY';
      material.opacity = THREE.MathUtils.lerp(material.opacity, occupied ? 1 : 0, blend);
      person.visible = material.opacity > 0.01;
      person.traverse(object => { if (object.isMesh) object.castShadow = material.opacity > 0.6; });
      colorTarget.set(STATES[status][2]);
      material.color.lerp(colorTarget, blend);
      ringMaterial.color.lerp(colorTarget, blend);
      ringMaterial.opacity = THREE.MathUtils.lerp(ringMaterial.opacity, occupied ? 0.32 : 0, blend);
      pathMaterial.opacity = THREE.MathUtils.lerp(pathMaterial.opacity, moving ? (reducedMotion.matches ? 0.4 : 0.4 + Math.sin(phase * 1.5) * 0.05) : 0, blend);
      if (!reducedMotion.matches) phase += delta;
      const swing = moving && !reducedMotion.matches ? Math.sin(phase * 3.2) * 0.13 : 0;
      arms[0].rotation.x = THREE.MathUtils.lerp(arms[0].rotation.x, swing, blend);
      arms[1].rotation.x = -arms[0].rotation.x;
      legs[0].rotation.x = -arms[0].rotation.x * 0.6;
      legs[1].rotation.x = arms[0].rotation.x * 0.6;
      if (lastTheme !== themeRef.current) {
        const dark = themeRef.current === 'dark';
        materialsByTheme.forEach(([mat, day, night]) => mat.color.set(dark ? night : day));
        ambient.intensity = dark ? 1.3 : 2.1;
        light.intensity = dark ? 2.5 : 3.2;
        lastTheme = themeRef.current;
      }
      function positionLabel(ref, point) {
        if (!ref.current) return;
        const projected = point.clone().project(camera);
        ref.current.style.left = `${(projected.x * 0.5 + 0.5) * 100}%`;
        ref.current.style.top = `${(-projected.y * 0.5 + 0.5) * container.clientHeight}px`;
      }
      positionLabel(routerLabel, routerPosition);
      positionLabel(sensorLabel, sensorPosition);
      renderer.render(scene, camera);
    }
    frame = requestAnimationFrame(animate);
    const lost = event => { event.preventDefault(); setUnavailable(true); };
    const restored = () => setUnavailable(false);
    renderer.domElement.addEventListener('webglcontextlost', lost);
    renderer.domElement.addEventListener('webglcontextrestored', restored);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      observer.disconnect();
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      renderer.domElement.removeEventListener('webglcontextrestored', restored);
      const geometries = new Set();
      const materials = new Set();
      scene.traverse(object => {
        if (object.geometry) geometries.add(object.geometry);
        if (object.material) (Array.isArray(object.material) ? object.material : [object.material]).forEach(item => materials.add(item));
      });
      geometries.forEach(item => item.dispose());
      materials.forEach(item => item.dispose());
      light.shadow.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  const activityLabel = { ACTIVITY_HIGH: 'High', ACTIVITY_MEDIUM: 'Medium', ACTIVITY_LOW: 'Low' }[activity] ?? 'Unknown';
  return (
    <section className="card presence-scene-card" aria-label="3D presence visualization">
      <div className="signal-header">
        <div><div className="signal-eyebrow">WI-FI SENSING / SPATIAL VIEW</div><h2 className="signal-title">Presence, visualized</h2></div>
        <span className="presence-scene-tag">{ready ? 'Sensor connected' : 'Awaiting sensor'}</span>
      </div>
      <div className="presence-scene-layout">
        <div className="presence-scene-stage">
          <div className="presence-scene-canvas" ref={host} aria-hidden="true" />
          <div className="presence-device-label" ref={routerLabel}>Router <span>Wi-Fi source</span></div>
          <div className="presence-device-label" ref={sensorLabel}>ESP32 <span>Sensing node</span></div>
          <div className="presence-scene-overlay">
            <div className="presence-scene-state" style={{ '--presence-color': color }} aria-live="polite"><span />{label}</div>
            <dl className="presence-scene-metrics">
              <div><dt>Activity</dt><dd>{activityLabel}</dd></div>
              <div><dt>Motion score</dt><dd>{Number.isFinite(motionScore) ? motionScore.toFixed(3) : '—'}</dd></div>
              <div><dt>Sensor</dt><dd>{sensorStatus?.replaceAll('_', ' ') ?? (ready ? 'Healthy' : 'Not ready')}</dd></div>
            </dl>
          </div>
          <span className="presence-scene-stage-label">ILLUSTRATIVE ROOM · DEVICE POSITIONS ARE SYMBOLIC</span>
          {unavailable && <div className="presence-scene-fallback">3D view unavailable on this browser.<br />Live presence status remains available below.</div>}
        </div>
        <div className="presence-scene-details">
          <div className="presence-scene-caption">SENSING INTERPRETATION</div>
          <h3>{label}</h3>
          <p>{description}</p>
          <div className="presence-scene-state-list">
            {Object.entries(STATES).map(([key, [name]]) => <span key={key} className={effective === key ? 'selected' : ''}><i />{name}{effective === key && <small>Current</small>}</span>)}
          </div>
          <p className="presence-scene-note">An illustration of inferred presence, not a room scan. Person position, path and device placement are symbolic. Location, pose and people count are not measured.</p>
        </div>
      </div>
    </section>
  );
}
