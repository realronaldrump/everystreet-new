import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

import {
  buildStreetPairPositions,
  buildTerrainMeshData,
  createLocalProjection,
} from "./terrain.js";

const COLORS = Object.freeze({
  dark: {
    background: 0x050507,
    terrain: 0x24242a,
    boundary: 0x8aa7df,
    driven: [0.43, 0.63, 0.96],
    undriven: [0.92, 0.58, 0.2],
    selected: 0xffe3a2,
    hover: 0xffffff,
  },
  light: {
    background: 0xe9e4d8,
    terrain: 0xbdb7aa,
    boundary: 0x405f9a,
    driven: [0.21, 0.38, 0.68],
    undriven: [0.7, 0.38, 0.12],
    selected: 0x7d4c00,
    hover: 0x11100e,
  },
});

export default class CoverageDioramaRenderer {
  constructor(container, options = {}) {
    this.container = container;
    this.onHover = options.onHover || (() => {});
    this.onSelectionChange = options.onSelectionChange || (() => {});
    this.onInteractionError = options.onInteractionError || (() => {});
    this.mode = "explore";
    this.verticalScale = 2.5;
    this.source = null;
    this.projection = null;
    this.baseElevation = 0;
    this.sceneObjects = [];
    this.pickLines = [];
    this.lineMaterials = new Set();
    this.featurePositions = new Map();
    this.featureById = new Map();
    this.selectedIds = new Set();
    this.hoveredId = null;
    this.painting = false;
    this.paintValue = true;
    this.raf = null;
    this.motionFrames = 0;
    this.disposed = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 1, 100_000);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.domElement.className = "coverage-diorama-webgl";
    this.renderer.domElement.setAttribute(
      "aria-label",
      "Interactive 3D terrain model of street coverage"
    );
    this.renderer.domElement.setAttribute("role", "img");
    this.container.replaceChildren(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.controls.minPolarAngle = Math.PI * 0.08;
    this.controls.addEventListener("change", () => this.invalidate(12));

    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Line2 = { threshold: 1.2 };
    this.pointer = new THREE.Vector2();

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.48, 0.35, 0.76);
    this.composer.addPass(this.bloomPass);

    this.hemisphereLight = new THREE.HemisphereLight(0xc7dcff, 0x30271c, 1.45);
    this.keyLight = new THREE.DirectionalLight(0xfff1d6, 2.3);
    this.keyLight.position.set(-1, 2.5, 1.2);
    this.scene.add(this.hemisphereLight, this.keyLight);

    this.boundPointerDown = (event) => this.handlePointerDown(event);
    this.boundPointerMove = (event) => this.handlePointerMove(event);
    this.boundPointerUp = (event) => this.handlePointerUp(event);
    this.boundPointerLeave = () => this.handlePointerLeave();
    this.boundThemeChanged = () => this.applyTheme();
    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", this.boundPointerDown);
    canvas.addEventListener("pointermove", this.boundPointerMove);
    canvas.addEventListener("pointerup", this.boundPointerUp);
    canvas.addEventListener("pointercancel", this.boundPointerUp);
    canvas.addEventListener("pointerleave", this.boundPointerLeave);
    document.addEventListener("themeChanged", this.boundThemeChanged);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.applyTheme();
    this.resize();
  }

  pixelRatio() {
    const isCompact = globalThis.matchMedia?.("(max-width: 767px)")?.matches;
    return Math.min(globalThis.devicePixelRatio || 1, isCompact ? 1.25 : 1.5);
  }

  setModel(source) {
    this.source = source;
    this.projection = createLocalProjection(source.bounds);
    this.selectedIds.clear();
    this.hoveredId = null;
    this.rebuildModel();
    this.onSelectionChange(this.getSelection());
  }

  setMode(mode) {
    this.mode = mode === "plan" ? "plan" : "explore";
    this.controls.enabled = this.mode === "explore";
    this.renderer.domElement.classList.toggle("is-planning", this.mode === "plan");
    this.painting = false;
    if (this.mode !== "explore") {
      this.setHoveredFeature(null);
    }
    this.invalidate();
  }

  setVerticalScale(scale) {
    const normalized = Number(scale) === 1 ? 1 : 2.5;
    if (normalized === this.verticalScale || !this.source) {
      return;
    }
    this.verticalScale = normalized;
    this.rebuildModel({ preserveSelection: true });
  }

  resetCamera() {
    if (!this.source) {
      return;
    }
    this.fitCamera(this.modelSpan || 10_000);
  }

  clearSelection() {
    if (this.selectedIds.size === 0) {
      return;
    }
    this.selectedIds.clear();
    this.refreshSelectedOverlay();
    this.onSelectionChange(this.getSelection());
  }

  getSelection() {
    return Array.from(this.selectedIds)
      .map((id) => this.featureById.get(id))
      .filter(Boolean);
  }

  rebuildModel({ preserveSelection = false } = {}) {
    const previousSelection = preserveSelection ? new Set(this.selectedIds) : new Set();
    this.clearSceneObjects();
    this.featurePositions.clear();
    this.featureById.clear();
    this.pickLines = [];

    const resolution = globalThis.matchMedia?.("(max-width: 767px)")?.matches
      ? 128
      : 192;
    const terrainData = buildTerrainMeshData({
      bounds: this.source.bounds,
      boundary: this.source.boundary,
      mosaic: this.source.mosaic,
      projection: this.projection,
      resolution,
      verticalScale: this.verticalScale,
    });
    this.baseElevation = terrainData.minElevation;
    this.modelSpan = terrainData.horizontalSpan;
    this.createTerrain(terrainData);
    this.createBoundaryLine();
    this.createStreetLayers();

    this.selectedIds = new Set(
      Array.from(previousSelection).filter((id) => this.featureById.has(id))
    );
    this.refreshSelectedOverlay();
    this.fitCamera(this.modelSpan);
    this.applyTheme();
    this.invalidate(30);
  }

  createTerrain(terrainData) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(terrainData.positions, 3)
    );
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({
      color: COLORS.dark.terrain,
      roughness: 0.9,
      metalness: 0.04,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.dioramaKind = "terrain";
    this.addSceneObject(mesh);
  }

  createBoundaryLine() {
    const positions = [];
    const appendBoundaryPoint = (coordinate) => {
      const world = this.projectBoundaryPoint(coordinate);
      if (world) {
        positions.push(world.x, world.y, world.z);
      }
    };
    for (const ring of outerBoundaryRings(this.source.boundary)) {
      for (let index = 1; index < ring.length; index += 1) {
        appendBoundaryPoint(ring[index - 1]);
        appendBoundaryPoint(ring[index]);
      }
    }
    if (positions.length === 0) {
      return;
    }
    const line = this.createLineObject({
      positions,
      color: COLORS.dark.boundary,
      linewidth: 1.25,
      opacity: 0.7,
      kind: "boundary",
    });
    this.addSceneObject(line);
  }

  projectBoundaryPoint(coordinate) {
    const feature = {
      geometry: { type: "LineString", coordinates: [coordinate, coordinate] },
    };
    const pair = buildStreetPairPositions(feature, {
      mosaic: this.source.mosaic,
      projection: this.projection,
      baseElevation: this.baseElevation,
      verticalScale: this.verticalScale,
      liftM: 4,
      maxDistanceM: Number.POSITIVE_INFINITY,
    });
    return pair.length >= 3 ? { x: pair[0], y: pair[1], z: pair[2] } : null;
  }

  createStreetLayers() {
    const batches = {
      driven: { positions: [], colors: [], featureByPair: [] },
      undriven: { positions: [], colors: [], featureByPair: [] },
    };

    for (const feature of this.source.features) {
      const status = normalizedStatus(feature);
      if (!(status in batches)) {
        continue;
      }
      const segmentId = String(feature.properties?.segment_id || "");
      if (!segmentId) {
        continue;
      }
      const positions = buildStreetPairPositions(feature, {
        mosaic: this.source.mosaic,
        projection: this.projection,
        baseElevation: this.baseElevation,
        verticalScale: this.verticalScale,
        liftM: status === "driven" ? 3.5 : 2.4,
        maxDistanceM: 90,
      });
      if (positions.length === 0) {
        continue;
      }
      this.featurePositions.set(segmentId, positions);
      this.featureById.set(segmentId, feature);
      appendValues(batches[status].positions, positions);
      const pairCount = positions.length / 6;
      const color = COLORS.dark[status];
      for (let pair = 0; pair < pairCount; pair += 1) {
        batches[status].featureByPair.push(feature);
        batches[status].colors.push(...color, ...color);
      }
    }

    for (const status of ["driven", "undriven"]) {
      const batch = batches[status];
      if (batch.positions.length === 0) {
        continue;
      }
      if (status === "driven") {
        const glow = this.createLineObject({
          positions: batch.positions,
          color: 0x6f8fce,
          linewidth: 7,
          opacity: 0.12,
          kind: "driven-glow",
        });
        this.addSceneObject(glow);
      }
      const line = this.createLineObject({
        positions: batch.positions,
        colors: batch.colors,
        linewidth: status === "driven" ? 2.8 : 2.1,
        opacity: status === "driven" ? 0.94 : 0.8,
        kind: status,
      });
      line.userData.featureByPair = batch.featureByPair;
      this.pickLines.push(line);
      this.addSceneObject(line);
    }
  }

  createLineObject({ positions, colors, color, linewidth, opacity, kind }) {
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    if (colors) {
      geometry.setColors(colors);
    }
    const material = new LineMaterial({
      color: color ?? 0xffffff,
      linewidth,
      vertexColors: Boolean(colors),
      transparent: opacity < 1,
      opacity,
      depthWrite: false,
      worldUnits: false,
    });
    material.resolution.set(
      this.container.clientWidth || 1,
      this.container.clientHeight || 1
    );
    this.lineMaterials.add(material);
    const line = new LineSegments2(geometry, material);
    line.computeLineDistances();
    line.userData.dioramaKind = kind;
    return line;
  }

  refreshSelectedOverlay() {
    this.removeOverlay("selection");
    if (this.selectedIds.size === 0) {
      this.invalidate();
      return;
    }
    const positions = [];
    for (const id of this.selectedIds) {
      appendValues(positions, this.featurePositions.get(id) || []);
    }
    const line = this.createLineObject({
      positions,
      color: this.palette().selected,
      linewidth: 5.2,
      opacity: 1,
      kind: "selection",
    });
    line.renderOrder = 20;
    this.addSceneObject(line);
    this.invalidate(8);
  }

  setHoveredFeature(feature) {
    const id = feature ? String(feature.properties?.segment_id || "") : null;
    if (id === this.hoveredId) {
      return;
    }
    this.hoveredId = id;
    this.removeOverlay("hover");
    if (id && this.featurePositions.has(id)) {
      const line = this.createLineObject({
        positions: this.featurePositions.get(id),
        color: this.palette().hover,
        linewidth: 4.2,
        opacity: 0.95,
        kind: "hover",
      });
      line.renderOrder = 19;
      this.addSceneObject(line);
    }
    this.onHover(feature || null);
    this.invalidate();
  }

  removeOverlay(kind) {
    const object = this.sceneObjects.find(
      (candidate) => candidate.userData.dioramaKind === kind
    );
    if (!object) {
      return;
    }
    this.scene.remove(object);
    this.sceneObjects = this.sceneObjects.filter((candidate) => candidate !== object);
    this.disposeObject(object);
  }

  addSceneObject(object) {
    this.scene.add(object);
    this.sceneObjects.push(object);
  }

  fitCamera(span) {
    const safeSpan = Math.max(500, span);
    this.camera.near = Math.max(1, safeSpan / 10_000);
    this.camera.far = safeSpan * 8;
    this.camera.updateProjectionMatrix();
    this.camera.position.set(safeSpan * 0.68, safeSpan * 0.72, safeSpan * 0.72);
    this.controls.target.set(0, safeSpan * 0.025, 0);
    this.controls.minDistance = safeSpan * 0.18;
    this.controls.maxDistance = safeSpan * 3.2;
    this.controls.update();
    this.invalidate(30);
  }

  pickFeature(event, onlyUndriven = false) {
    if (this.pickLines.length === 0) {
      return null;
    }
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const candidates = onlyUndriven
      ? this.pickLines.filter((line) => line.userData.dioramaKind === "undriven")
      : this.pickLines;
    const hit = this.raycaster.intersectObjects(candidates, false)[0];
    return hit?.object?.userData?.featureByPair?.[hit.faceIndex] || null;
  }

  handlePointerDown(event) {
    if (this.mode !== "plan" || event.button !== 0) {
      return;
    }
    const feature = this.pickFeature(event, true);
    if (!feature) {
      return;
    }
    event.preventDefault();
    this.renderer.domElement.setPointerCapture?.(event.pointerId);
    this.painting = true;
    const id = String(feature.properties.segment_id);
    this.paintValue = !this.selectedIds.has(id);
    this.paintFeature(feature);
  }

  handlePointerMove(event) {
    if (this.mode === "plan") {
      if (this.painting) {
        const feature = this.pickFeature(event, true);
        if (feature) {
          this.paintFeature(feature);
        }
      }
      return;
    }
    this.setHoveredFeature(this.pickFeature(event, false));
  }

  handlePointerUp(event) {
    this.painting = false;
    if (this.renderer.domElement.hasPointerCapture?.(event.pointerId)) {
      this.renderer.domElement.releasePointerCapture(event.pointerId);
    }
  }

  handlePointerLeave() {
    if (!this.painting) {
      this.setHoveredFeature(null);
    }
  }

  paintFeature(feature) {
    const id = String(feature.properties?.segment_id || "");
    if (!id) {
      return;
    }
    const hasId = this.selectedIds.has(id);
    if (this.paintValue === hasId) {
      return;
    }
    if (this.paintValue) {
      this.selectedIds.add(id);
    } else {
      this.selectedIds.delete(id);
    }
    this.refreshSelectedOverlay();
    this.onSelectionChange(this.getSelection());
  }

  resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(this.pixelRatio());
    this.composer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    for (const material of this.lineMaterials) {
      material.resolution.set(width, height);
    }
    this.invalidate();
  }

  palette() {
    return document.documentElement.dataset.bsTheme === "light"
      ? COLORS.light
      : COLORS.dark;
  }

  applyTheme() {
    const palette = this.palette();
    this.scene.background = new THREE.Color(palette.background);
    this.renderer.setClearColor(palette.background, 1);
    for (const object of this.sceneObjects) {
      if (object.userData.dioramaKind === "terrain") {
        object.material.color.setHex(palette.terrain);
      } else if (object.userData.dioramaKind === "boundary") {
        object.material.color.setHex(palette.boundary);
      } else if (object.userData.dioramaKind === "selection") {
        object.material.color.setHex(palette.selected);
      } else if (object.userData.dioramaKind === "hover") {
        object.material.color.setHex(palette.hover);
      }
    }
    this.invalidate();
  }

  invalidate(frames = 1) {
    if (this.disposed) {
      return;
    }
    this.motionFrames = Math.max(this.motionFrames, frames);
    if (this.raf === null) {
      this.raf = requestAnimationFrame(() => this.renderFrame());
    }
  }

  renderFrame() {
    this.raf = null;
    if (this.disposed) {
      return;
    }
    try {
      this.controls.update();
      this.composer.render();
    } catch (error) {
      this.onInteractionError(error);
      return;
    }
    this.motionFrames -= 1;
    if (this.motionFrames > 0) {
      this.raf = requestAnimationFrame(() => this.renderFrame());
    }
  }

  clearSceneObjects() {
    for (const object of this.sceneObjects) {
      this.scene.remove(object);
      this.disposeObject(object);
    }
    this.sceneObjects = [];
    this.lineMaterials.clear();
  }

  disposeObject(object) {
    object.geometry?.dispose?.();
    if (Array.isArray(object.material)) {
      object.material.forEach((material) => {
        this.lineMaterials.delete(material);
        material.dispose?.();
      });
    } else {
      this.lineMaterials.delete(object.material);
      object.material?.dispose?.();
    }
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    this.resizeObserver.disconnect();
    document.removeEventListener("themeChanged", this.boundThemeChanged);
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.boundPointerDown);
    canvas.removeEventListener("pointermove", this.boundPointerMove);
    canvas.removeEventListener("pointerup", this.boundPointerUp);
    canvas.removeEventListener("pointercancel", this.boundPointerUp);
    canvas.removeEventListener("pointerleave", this.boundPointerLeave);
    this.controls.dispose();
    this.clearSceneObjects();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    canvas.remove();
  }
}

function normalizedStatus(feature) {
  const status = String(feature?.properties?.status || "undriven").toLowerCase();
  return status === "driven"
    ? "driven"
    : status === "undriveable"
      ? "undriveable"
      : "undriven";
}

function outerBoundaryRings(boundary) {
  if (boundary?.type === "Polygon") {
    return boundary.coordinates?.[0] ? [boundary.coordinates[0]] : [];
  }
  if (boundary?.type === "MultiPolygon") {
    return (boundary.coordinates || []).map((polygon) => polygon?.[0]).filter(Boolean);
  }
  return [];
}

function appendValues(target, values) {
  for (const value of values) {
    target.push(value);
  }
}
