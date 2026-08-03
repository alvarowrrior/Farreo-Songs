"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useMusicPlayer } from "@/components/MusicPlayerProvider";
import { addFarreoNativeListener, getFarreoNativeAudio } from "@/lib/nativeAudio";
import { getMediaUrl } from "@/lib/radioApi";

interface AlbumDiscBackdropProps {
  artworkUrl?: string | null;
  isPlaying: boolean;
  mobile?: boolean;
  visible?: boolean;
}

const DISC_ROTATION_SPEED = 0.42;
const DISC_THICKNESS = 0.034;
const DISC_HALF_THICKNESS = DISC_THICKNESS / 2;
const ALBUM_DISC_VISIBILITY_EVENT = "farreo:album-disc-visibility";

const sampleCircularSpectrum = (
  data: Uint8Array<ArrayBufferLike>,
  index: number,
  barCount: number,
) => {
  if (data.length === 0) return 0;
  const half = Math.max(2, Math.floor(barCount / 2));
  const mirroredIndex = index < half ? index : barCount - 1 - index;
  const position = Math.max(0, mirroredIndex) / Math.max(1, half - 1);
  const usefulBins = Math.max(1, Math.floor(data.length * 0.58));
  // The visual center receives bass/mids; both ends taper towards the lightest frequencies.
  const spectralPosition = 0.015 + (Math.pow(1 - position, 1.7) * 0.985);
  const bin = Math.min(usefulBins - 1, Math.floor(spectralPosition * usefulBins));
  const previous = data[Math.max(0, bin - 1)] ?? 0;
  const current = data[bin] ?? 0;
  const next = data[Math.min(data.length - 1, bin + 1)] ?? 0;
  return ((previous * 0.22) + (current * 0.56) + (next * 0.22)) / 255;
};

const makeFallbackTexture = () => {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(256, 220, 20, 256, 256, 330);
    gradient.addColorStop(0, "#2ee87a");
    gradient.addColorStop(0.38, "#173c29");
    gradient.addColorStop(1, "#050706");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 512, 512);
    context.fillStyle = "rgba(255, 255, 255, 0.9)";
    context.font = "900 230px sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("F", 256, 260);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

const makeDiscFaceMask = () => {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = "#fff";
    context.fillRect(0, 0, 512, 512);
    context.fillStyle = "#000";
    context.beginPath();
    context.arc(256, 256, 16, 0, Math.PI * 2);
    context.fill();
  }
  return new THREE.CanvasTexture(canvas);
};

export default function AlbumDiscBackdrop({ artworkUrl, isPlaying, mobile = false, visible = true }: AlbumDiscBackdropProps) {
  const { getAudioFrequencyData } = useMusicPlayer();
  const resolvedArtwork = artworkUrl ? getMediaUrl(artworkUrl) : "";
  const [readyArtwork, setReadyArtwork] = useState<string | null>(null);
  const textureReady = readyArtwork === resolvedArtwork;
  const discVisible = visible && textureReady;
  const hostRef = useRef<HTMLDivElement>(null);
  const playingRef = useRef(isPlaying);
  const visibleRef = useRef(discVisible);
  const frequencyGetterRef = useRef(getAudioFrequencyData);
  const nativeFrequencyDataRef = useRef<Uint8Array | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const faceMaterialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const fallbackTextureRef = useRef<THREE.Texture | null>(null);
  const loadedTextureRef = useRef<THREE.Texture | null>(null);

  useEffect(() => {
    playingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    visibleRef.current = discVisible;
  }, [discVisible]);

  useEffect(() => {
    frequencyGetterRef.current = getAudioFrequencyData;
  }, [getAudioFrequencyData]);

  useEffect(() => {
    if (discVisible) document.documentElement.dataset.albumDiscVisual = "true";
    else delete document.documentElement.dataset.albumDiscVisual;
    window.dispatchEvent(new Event(ALBUM_DISC_VISIBILITY_EVENT));
    return () => {
      if (discVisible) {
        delete document.documentElement.dataset.albumDiscVisual;
        window.dispatchEvent(new Event(ALBUM_DISC_VISIBILITY_EVENT));
      }
    };
  }, [discVisible]);

  useEffect(() => {
    const native = getFarreoNativeAudio();
    if (!native) return undefined;
    const listener = addFarreoNativeListener("frequency", (payload) => {
      if (!payload || typeof payload !== "object") return;
      const samples = (payload as { samples?: unknown }).samples;
      if (!Array.isArray(samples)) return;
      nativeFrequencyDataRef.current = Uint8Array.from(
        samples.map((value) => Math.max(0, Math.min(255, Number(value) || 0))),
      );
    });
    return () => {
      void listener.then((handle) => handle?.remove()).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!isPlaying) return;
    void getFarreoNativeAudio()?.enableVisualization().catch(() => undefined);
  }, [isPlaying]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(mobile ? 38 : 31, 1, 0.1, 40);
    camera.position.set(0, mobile ? 4.6 : 4.1, mobile ? 8.8 : 8.3);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.25 : 1.6));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.setAttribute("aria-hidden", "true");
    renderer.domElement.dataset.albumDiscCanvas = mobile ? "mobile" : "desktop";
    host.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const discPivot = new THREE.Group();
    discPivot.rotation.z = mobile ? -0.17 : -0.23;
    discPivot.rotation.x = mobile ? 0.08 : 0.02;
    discPivot.position.x = mobile ? 0.12 : 1.15;
    discPivot.position.y = mobile ? -0.15 : -0.28;
    scene.add(discPivot);

    const spinningDisc = new THREE.Group();
    discPivot.add(spinningDisc);

    const waveBarCount = mobile ? 88 : 120;
    const waveLevels = new Float32Array(waveBarCount);
    const waveBarGeometry = new THREE.BoxGeometry(1, 0.003, mobile ? 0.032 : 0.028);
    const waveBarMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: mobile ? 0.94 : 0.9,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const waveBars = new THREE.InstancedMesh(waveBarGeometry, waveBarMaterial, waveBarCount);
    waveBars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    waveBars.renderOrder = 2;
    discPivot.add(waveBars);
    const waveTransform = new THREE.Object3D();

    const updateWaveBars = (frequencyData: Uint8Array<ArrayBufferLike> | null, delta: number) => {
      const attack = 1 - Math.exp(-delta * 18);
      const release = 1 - Math.exp(-delta * 5.5);
      for (let index = 0; index < waveBarCount; index += 1) {
        const rawLevel = frequencyData ? sampleCircularSpectrum(frequencyData, index, waveBarCount) : 0;
        const normalizedLevel = Math.min(1, Math.max(0, (rawLevel - 0.035) / 0.9));
        const target = Math.pow(normalizedLevel, 1.32);
        const previous = waveLevels[index] ?? 0;
        const level = previous + ((target - previous) * (target > previous ? attack : release));
        waveLevels[index] = level;

        const angle = (index / waveBarCount) * Math.PI * 2;
        const distanceFromCenter = Math.abs((index / Math.max(1, waveBarCount - 1)) - 0.5) * 2;
        const spatialEnvelope = Math.pow(Math.max(0, 1 - distanceFromCenter), 5.2);
        const visibleLevel = level * spatialEnvelope;
        const normalizedVisibleLevel = visibleLevel < 0.028
          ? 0
          : (visibleLevel - 0.028) / 0.972;
        const length = normalizedVisibleLevel * (mobile ? 0.225 : 0.265);
        const radius = 2.445 + (length / 2);
        // The silent tip sits below the song list; the responsive tip remains on the opposite side.
        const visualAngle = angle - (Math.PI / 2);
        waveTransform.position.set(Math.cos(visualAngle) * radius, DISC_HALF_THICKNESS + 0.005, Math.sin(visualAngle) * radius);
        waveTransform.rotation.set(0, -visualAngle, 0);
        if (length === 0) waveTransform.scale.setScalar(0);
        else waveTransform.scale.set(length, 1, 1);
        waveTransform.updateMatrix();
        waveBars.setMatrixAt(index, waveTransform.matrix);
      }
      waveBars.instanceMatrix.needsUpdate = true;
    };
    updateWaveBars(null, 1);

    const fallbackTexture = makeFallbackTexture();
    const discFaceMask = makeDiscFaceMask();
    const faceMaterial = new THREE.MeshStandardMaterial({
      map: fallbackTexture,
      alphaMap: discFaceMask,
      alphaTest: 0.5,
      color: 0xffffff,
      roughness: 0.58,
      metalness: 0.2,
      transparent: true,
      opacity: mobile ? 0.58 : 0.57,
    });
    faceMaterialRef.current = faceMaterial;
    fallbackTextureRef.current = fallbackTexture;
    const edgeMaterial = new THREE.MeshStandardMaterial({
      color: 0x202523,
      roughness: 0.28,
      metalness: 0.92,
      transparent: true,
      opacity: 0.68,
      side: THREE.DoubleSide,
    });
    const undersideMaterial = new THREE.MeshStandardMaterial({
      color: 0x090b0a,
      roughness: 0.36,
      metalness: 0.82,
      transparent: true,
      opacity: 0.66,
      side: THREE.DoubleSide,
    });
    const topFaceGeometry = new THREE.CircleGeometry(2.42, 96);
    const topFace = new THREE.Mesh(topFaceGeometry, faceMaterial);
    topFace.rotation.x = -Math.PI / 2;
    topFace.position.y = DISC_HALF_THICKNESS + 0.001;
    spinningDisc.add(topFace);

    const bottomFaceGeometry = new THREE.RingGeometry(0.145, 2.42, 96, 1);
    const bottomFace = new THREE.Mesh(bottomFaceGeometry, undersideMaterial);
    bottomFace.rotation.x = Math.PI / 2;
    bottomFace.position.y = -(DISC_HALF_THICKNESS + 0.001);
    spinningDisc.add(bottomFace);

    const outerWallGeometry = new THREE.CylinderGeometry(2.42, 2.42, DISC_THICKNESS, 96, 1, true);
    const outerWall = new THREE.Mesh(outerWallGeometry, edgeMaterial);
    spinningDisc.add(outerWall);

    const innerWallGeometry = new THREE.CylinderGeometry(0.145, 0.145, DISC_THICKNESS, 64, 1, true);
    const innerWall = new THREE.Mesh(innerWallGeometry, edgeMaterial);
    spinningDisc.add(innerWall);

    const ringMaterial = new THREE.MeshStandardMaterial({
      color: 0xc8d1cc,
      roughness: 0.22,
      metalness: 0.96,
      transparent: true,
      opacity: mobile ? 0.3 : 0.25,
    });
    const ringRadii = [0.64, 1.12, 1.58, 1.97, 2.27];
    const rings = ringRadii.map((radius) => {
      const geometry = new THREE.TorusGeometry(radius, radius === 2.27 ? 0.026 : 0.012, 8, 96);
      const mesh = new THREE.Mesh(geometry, ringMaterial);
      mesh.rotation.x = Math.PI / 2;
      mesh.position.y = DISC_HALF_THICKNESS + 0.003;
      spinningDisc.add(mesh);
      return mesh;
    });

    const holeRimGeometry = new THREE.TorusGeometry(0.145, 0.012, 8, 64);
    const holeRimMaterial = new THREE.MeshStandardMaterial({
      color: 0x111412,
      roughness: 0.48,
      metalness: 0.45,
      transparent: true,
      opacity: 0.58,
    });
    const holeRim = new THREE.Mesh(holeRimGeometry, holeRimMaterial);
    holeRim.rotation.x = Math.PI / 2;
    holeRim.position.y = DISC_HALF_THICKNESS + 0.002;
    spinningDisc.add(holeRim);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x07110b, mobile ? 1.35 : 1.2));
    const keyLight = new THREE.DirectionalLight(0xffffff, mobile ? 2.2 : 1.85);
    keyLight.position.set(-3.5, 6, 4.5);
    scene.add(keyLight);
    const greenLight = new THREE.PointLight(0x1ed760, mobile ? 8 : 6, 15);
    greenLight.position.set(3.8, 1.8, 3.2);
    scene.add(greenLight);

    let disposed = false;

    const resize = () => {
      const { width, height } = host.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      const compact = width < 560;
      discPivot.scale.setScalar(compact ? 0.82 : mobile ? 0.96 : 1.08);
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    window.addEventListener("resize", resize);

    let animationFrame = 0;
    let previousFrameTime = 0;
    const render = (frameTime = 0) => {
      if (disposed) return;
      const delta = previousFrameTime > 0 ? Math.min((frameTime - previousFrameTime) / 1000, 0.05) : 0;
      previousFrameTime = frameTime;
      if (!document.hidden && (visibleRef.current || playingRef.current)) {
        const frequencyData = playingRef.current
          ? nativeFrequencyDataRef.current || frequencyGetterRef.current()
          : null;
        updateWaveBars(frequencyData, delta);
        if (playingRef.current) {
          spinningDisc.rotation.y = (spinningDisc.rotation.y + delta * DISC_ROTATION_SPEED) % (Math.PI * 2);
        }
        renderer.render(scene, camera);
      }
      animationFrame = window.requestAnimationFrame(render);
    };
    render();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      window.removeEventListener("resize", resize);
      topFaceGeometry.dispose();
      bottomFaceGeometry.dispose();
      outerWallGeometry.dispose();
      innerWallGeometry.dispose();
      waveBarGeometry.dispose();
      holeRimGeometry.dispose();
      rings.forEach((ring) => ring.geometry.dispose());
      faceMaterial.dispose();
      edgeMaterial.dispose();
      undersideMaterial.dispose();
      waveBarMaterial.dispose();
      ringMaterial.dispose();
      holeRimMaterial.dispose();
      fallbackTexture.dispose();
      discFaceMask.dispose();
      loadedTextureRef.current?.dispose();
      loadedTextureRef.current = null;
      if (rendererRef.current === renderer) rendererRef.current = null;
      if (faceMaterialRef.current === faceMaterial) faceMaterialRef.current = null;
      if (fallbackTextureRef.current === fallbackTexture) fallbackTextureRef.current = null;
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [mobile]);

  useEffect(() => {
    const renderer = rendererRef.current;
    const faceMaterial = faceMaterialRef.current;
    const fallbackTexture = fallbackTextureRef.current;
    if (!renderer || !faceMaterial || !fallbackTexture) return undefined;

    if (!resolvedArtwork) {
      const previous = loadedTextureRef.current;
      loadedTextureRef.current = null;
      faceMaterial.map = fallbackTexture;
      faceMaterial.needsUpdate = true;
      previous?.dispose();
      const readyFrame = window.requestAnimationFrame(() => setReadyArtwork(resolvedArtwork));
      return () => window.cancelAnimationFrame(readyFrame);
    }

    let cancelled = false;
    new THREE.TextureLoader().load(
      resolvedArtwork,
      (texture) => {
        if (cancelled || faceMaterialRef.current !== faceMaterial) {
          texture.dispose();
          return;
        }
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
        const previous = loadedTextureRef.current;
        loadedTextureRef.current = texture;
        faceMaterial.map = texture;
        faceMaterial.needsUpdate = true;
        previous?.dispose();
        setReadyArtwork(resolvedArtwork);
      },
      undefined,
      () => {
        if (!cancelled) setReadyArtwork(resolvedArtwork);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [mobile, resolvedArtwork]);

  return (
    <div
      ref={hostRef}
      className={`album-disc-backdrop ${mobile ? "album-disc-backdrop--mobile" : "album-disc-backdrop--desktop"} ${discVisible ? "album-disc-backdrop--visible" : ""}`}
      data-playing={isPlaying ? "true" : "false"}
      aria-hidden="true"
    />
  );
}
