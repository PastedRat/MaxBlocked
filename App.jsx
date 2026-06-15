// App.jsx - Симулятор БПЛА "Лютый"
// Управление: W (вперёд), S (назад), A (влево), D (вправо), Space (вверх), Ctrl (вниз)
// Также работают стрелки для крена/тангажа (опционально), но основное - WASD + Space/Ctrl

import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// ----------------------------- 1. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ -----------------------------
const DEG = Math.PI / 180;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

const createAirfoilShape = (chord, thickness = 0.12, steps = 60) => {
  const shape = new THREE.Shape();
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * chord;
    const xc = x / chord;
    const yt = 5 * thickness * (0.2969 * Math.sqrt(xc) - 0.1260 * xc - 0.3516 * xc ** 2 + 0.2843 * xc ** 3 - 0.1015 * xc ** 4);
    if (i === 0) shape.moveTo(x, yt);
    else shape.lineTo(x, yt);
  }
  for (let i = steps; i >= 0; i--) {
    const x = (i / steps) * chord;
    const xc = x / chord;
    const yt = 5 * thickness * (0.2969 * Math.sqrt(xc) - 0.1260 * xc - 0.3516 * xc ** 2 + 0.2843 * xc ** 3 - 0.1015 * xc ** 4);
    shape.lineTo(x, -yt);
  }
  return shape;
};

// ----------------------------- 2. АУДИОСИСТЕМА (ИСПРАВЛЕНА) -----------------------------
class DroneAudio {
  constructor() {
    this.ctx = null;
    this.engineOsc = null;
    this.engineGain = null;
    this.propNoise = null;
    this.propGain = null;
    this.filter = null;
    this.isRunning = false;
  }

  async init() {
    if (this.isRunning && this.ctx?.state === 'running') return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.engineOsc = this.ctx.createOscillator();
      this.engineOsc.type = 'sawtooth';
      this.engineOsc.frequency.value = 70;
      this.filter = this.ctx.createBiquadFilter();
      this.filter.type = 'lowpass';
      this.filter.frequency.value = 800;
      this.filter.Q.value = 1.2;
      this.engineGain = this.ctx.createGain();
      this.engineGain.gain.value = 0;
      this.engineOsc.connect(this.filter);
      this.filter.connect(this.engineGain);
      this.engineGain.connect(this.ctx.destination);
      this.engineOsc.start();

      const bufferSize = this.ctx.sampleRate * 2;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
      this.propNoise = this.ctx.createBufferSource();
      this.propNoise.buffer = buffer;
      this.propNoise.loop = true;
      const propFilter = this.ctx.createBiquadFilter();
      propFilter.type = 'bandpass';
      propFilter.frequency.value = 300;
      propFilter.Q.value = 1.8;
      this.propGain = this.ctx.createGain();
      this.propGain.gain.value = 0;
      this.propNoise.connect(propFilter);
      propFilter.connect(this.propGain);
      this.propGain.connect(this.ctx.destination);
      this.propNoise.start();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.isRunning = true;
  }

  update(throttle, speed, boost, verticalFactor = 0) {
    if (!this.isRunning || !this.ctx || this.ctx.state !== 'running') return;
    const boostMult = boost ? 1.6 : 1;
    const targetFreq = 60 + throttle * 240 * boostMult + Math.min(speed * 15, 100);
    const targetVol = 0.03 + throttle * 0.25 + Math.abs(verticalFactor) * 0.05;
    this.engineOsc.frequency.setTargetAtTime(targetFreq, this.ctx.currentTime, 0.08);
    this.engineGain.gain.setTargetAtTime(targetVol, this.ctx.currentTime, 0.1);
    this.propGain.gain.setTargetAtTime(throttle * 0.2 + speed * 0.02, this.ctx.currentTime, 0.1);
    this.filter.frequency.setTargetAtTime(boost ? 1800 : 800, this.ctx.currentTime, 0.1);
  }

  stop() {
    if (this.engineGain) this.engineGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.5);
    if (this.propGain) this.propGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.5);
  }
}

// ----------------------------- 3. ФИЗИКА С НОВЫМ УПРАВЛЕНИЕМ -----------------------------
class FlightPhysics {
  constructor() {
    this.pos = new THREE.Vector3(0, 0.5, 0);
    this.vel = new THREE.Vector3(0, 0, 0);
    this.rot = new THREE.Euler(0, 0, 0, 'YXZ');
    this.throttle = 0;          // тяга (вперёд/назад)
    this.sideForce = 0;         // боковая сила (A/D)
    this.verticalForce = 0;     // вертикальная сила (Space/Ctrl)
    this.maxThrust = 0.028;
    this.dragCoeff = 0.985;
    this.liftCoeff = 0.008;
    this.gravity = 0.006;
    this.groundLevel = -2.2;
    this.boostMult = 1.55;
    this.pitchSpeed = 0.03;
    this.yawSpeed = 0.025;
    this.rollSpeed = 0.045;
    this.aoa = 0;
  }

  update(dt, inputs, isBoost) {
    // --- Тяга (W/S) ---
    let targetThr = 0;
    if (inputs.w) targetThr = 1;
    else if (inputs.s) targetThr = -0.5;   // реверс для торможения
    else targetThr = 0;
    this.throttle += (targetThr - this.throttle) * 3.0 * dt;
    const thrust = Math.abs(this.throttle) * this.maxThrust * (isBoost ? this.boostMult : 1);
    const thrustDirection = this.throttle > 0 ? 1 : -1;

    // --- Боковая сила (A/D) ---
    let targetSide = 0;
    if (inputs.d) targetSide = 1;
    else if (inputs.a) targetSide = -1;
    this.sideForce += (targetSide - this.sideForce) * 4.0 * dt;

    // --- Вертикальная сила (Space / Ctrl) ---
    let targetVertical = 0;
    if (inputs.Space) targetVertical = 1;
    else if (inputs.Ctrl) targetVertical = -1;
    this.verticalForce += (targetVertical - this.verticalForce) * 5.0 * dt;

    // --- Управление ориентацией (стрелки, но можно и без них) ---
    const pitchInp = (inputs.ArrowUp ? 1 : inputs.ArrowDown ? -1 : 0);
    const yawInp = 0;  // рыскание теперь от A/D, но оставим для совместимости
    const rollInp = (inputs.ArrowRight ? 1 : inputs.ArrowLeft ? -1 : 0);
    
    // Приоритет: если используется A/D для рыскания, то поворачиваем корпус
    if (Math.abs(this.sideForce) > 0.05) {
      this.rot.y += this.sideForce * this.yawSpeed * dt * 60;
    } else {
      this.rot.y *= 0.99;
    }
    this.rot.x += pitchInp * this.pitchSpeed * dt * 60;
    this.rot.z += rollInp * this.rollSpeed * dt * 60;
    if (!inputs.ArrowLeft && !inputs.ArrowRight) this.rot.z *= 0.96;
    this.rot.x = clamp(this.rot.x, -0.7, 0.7);

    // Угол атаки
    const forwardLocal = new THREE.Vector3(1, 0, 0).applyEuler(this.rot);
    const aoaRaw = Math.asin(clamp(forwardLocal.y, -0.5, 0.5));
    this.aoa = aoaRaw * 0.7 + this.aoa * 0.3;

    // --- Векторы сил ---
    const forward = new THREE.Vector3(1, 0, 0).applyEuler(this.rot);
    const right = new THREE.Vector3(0, 0, 1).applyEuler(this.rot);
    const up = new THREE.Vector3(0, 1, 0);
    const speed = this.vel.length();
    const liftForceMagnitude = (speed * speed) * this.liftCoeff * (1 + Math.abs(this.aoa) * 2);
    const thrustForce = forward.clone().multiplyScalar(thrust * thrustDirection);
    const sideForceVec = right.clone().multiplyScalar(this.sideForce * 0.015 * speed);
    const liftForce = up.clone().multiplyScalar(liftForceMagnitude);
    const verticalControlForce = up.clone().multiplyScalar(this.verticalForce * 0.025);
    const dragForce = this.vel.clone().multiplyScalar(-0.002 * speed);
    const gravityForce = new THREE.Vector3(0, -this.gravity, 0);

    this.vel.add(thrustForce).add(sideForceVec).add(liftForce).add(verticalControlForce).add(dragForce).add(gravityForce);
    this.vel.multiplyScalar(this.dragCoeff);
    this.pos.add(this.vel.clone().multiplyScalar(dt));

    // Коллизия с землёй
    if (this.pos.y < this.groundLevel + 0.4) {
      this.pos.y = this.groundLevel + 0.4;
      this.vel.y = Math.max(0, this.vel.y);
      this.vel.x *= 0.95;
      this.vel.z *= 0.95;
    }
    if (this.vel.length() > 5.0) this.vel.multiplyScalar(5.0 / this.vel.length());

    return { 
      throttle: Math.abs(this.throttle), 
      speed: this.vel.length() * 130, 
      aoa: this.aoa * 180 / Math.PI,
      vertical: this.verticalForce
    };
  }

  reset() {
    this.pos.set(0, 0.5, 0);
    this.vel.set(0, 0, 0);
    this.rot.set(0, 0, 0);
    this.throttle = 0;
    this.sideForce = 0;
    this.verticalForce = 0;
  }
}

// ----------------------------- 4. ОСНОВНОЙ КОМПОНЕНТ -----------------------------
export default function App() {
  const mountRef = useRef(null);
  const audioRef = useRef(new DroneAudio());
  const physicsRef = useRef(new FlightPhysics());
  const [flightActive, setFlightActive] = useState(false);
  const [camMode, setCamMode] = useState('follow');
  const [hudData, setHudData] = useState({ alt: 0, spd: 0, thr: 0, pitch: 0, roll: 0, aoa: 0 });
  const [boostActive, setBoostActive] = useState(false);

  // --- НОВАЯ СХЕМА УПРАВЛЕНИЯ ---
  const inputState = useRef({
    w: false, s: false, a: false, d: false,
    Space: false, Ctrl: false,
    ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false,
  });

  const handleKey = useCallback((e, pressed) => {
    let key = e.code === 'Space' ? 'Space' : e.code === 'ControlLeft' ? 'Ctrl' : e.key;
    // Игнорируем, если клавиша не в нашей карте
    if (!inputState.current.hasOwnProperty(key)) return;
    
    e.preventDefault();  // ОЧЕНЬ ВАЖНО: не даём браузеру прокручивать страницу
    inputState.current[key] = pressed;
    
    if (pressed && key === 'c' && flightActive) setCamMode(prev => prev === 'follow' ? 'fpv' : 'follow');
    if (pressed && key === 'r' && flightActive) physicsRef.current.reset();
  }, [flightActive]);

  useEffect(() => {
    const onKeyDown = (e) => handleKey(e, true);
    const onKeyUp = (e) => handleKey(e, false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [handleKey]);

  const startFlight = async () => {
    await audioRef.current.init();
    setFlightActive(true);
    setCamMode('follow');
    physicsRef.current.reset();
  };

  const handleFirstClick = useCallback(() => {
    if (!flightActive && audioRef.current.ctx?.state === 'suspended') {
      audioRef.current.init();
    }
  }, [flightActive]);

  // ----------------------------- 5. СЦЕНА THREE.JS (сокращённо, но полноценно) -----------------------------
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x03060c);
    scene.fog = new THREE.FogExp2(0x03060c, 0.003);
    const camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.1, 2000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);

    const orbitControls = new OrbitControls(camera, renderer.domElement);
    orbitControls.enableDamping = true;
    orbitControls.target.set(0, 1, 0);

    // Освещение
    const ambient = new THREE.AmbientLight(0x2a4a6a, 0.65);
    scene.add(ambient);
    const mainLight = new THREE.DirectionalLight(0xfff5e0, 1.6);
    mainLight.position.set(30, 60, 20);
    mainLight.castShadow = true;
    mainLight.shadow.mapSize.width = 2048;
    mainLight.shadow.mapSize.height = 2048;
    scene.add(mainLight);
    const fillLight = new THREE.PointLight(0x4466aa, 0.4);
    fillLight.position.set(-10, 20, 15);
    scene.add(fillLight);

    // Земля
    const groundPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(2000, 2000),
      new THREE.MeshStandardMaterial({ color: 0x1a2a3a, roughness: 0.85 })
    );
    groundPlane.rotation.x = -Math.PI / 2;
    groundPlane.position.y = -2.2;
    groundPlane.receiveShadow = true;
    scene.add(groundPlane);
    const gridHelper = new THREE.GridHelper(2000, 200, 0x3a6a9a, 0x1a3a5a);
    gridHelper.position.y = -2.1;
    scene.add(gridHelper);

    // Звёзды
    const starCanvas = document.createElement('canvas');
    starCanvas.width = 512;
    starCanvas.height = 512;
    const ctx = starCanvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 512, 512);
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 2000; i++) ctx.fillRect(Math.random() * 512, Math.random() * 512, 1, 1);
    const starTexture = new THREE.CanvasTexture(starCanvas);
    const starSphere = new THREE.Mesh(
      new THREE.SphereGeometry(900, 64, 64),
      new THREE.MeshStandardMaterial({ map: starTexture, side: THREE.BackSide })
    );
    scene.add(starSphere);

    // --------------------- МОДЕЛЬ ДРОНА (детализированная) ---------------------
    const droneGroup = new THREE.Group();
    scene.add(droneGroup);

    const matBody = new THREE.MeshStandardMaterial({ color: 0x7c8e9c, roughness: 0.5, metalness: 0.4 });
    const matDark = new THREE.MeshStandardMaterial({ color: 0x2a3a44, roughness: 0.7 });
    const matCamo = new THREE.MeshStandardMaterial({ color: 0x5a6e4a, roughness: 0.6 });
    const matGlass = new THREE.MeshPhysicalMaterial({ color: 0x88aacc, transmission: 0.6, transparent: true });
    const matRed = new THREE.MeshStandardMaterial({ color: 0xcc3322, emissive: 0x441100 });
    const matGreen = new THREE.MeshStandardMaterial({ color: 0x33cc55, emissive: 0x226622 });
    const matProp = new THREE.MeshStandardMaterial({ color: 0x111a22, metalness: 0.7 });

    const addMesh = (parent, geo, mat, pos, rot) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(pos.x, pos.y, pos.z);
      mesh.rotation.set(rot.x, rot.y, rot.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };

    // Фюзеляж
    const fuse = new THREE.Group();
    droneGroup.add(fuse);
    addMesh(fuse, new THREE.CylinderGeometry(0.48, 0.48, 2.4, 32), matBody, new THREE.Vector3(0.6, 0, 0), new THREE.Vector3(0, 0, Math.PI / 2));
    addMesh(fuse, new THREE.CylinderGeometry(0.52, 0.5, 1.6, 32), matBody, new THREE.Vector3(-0.4, 0, 0), new THREE.Vector3(0, 0, Math.PI / 2));
    addMesh(fuse, new THREE.ConeGeometry(0.48, 1.2, 32), matBody, new THREE.Vector3(1.4, 0, 0), new THREE.Vector3(0, 0, Math.PI / 2));
    addMesh(fuse, new THREE.CylinderGeometry(0.32, 0.24, 1.2, 24), matDark, new THREE.Vector3(-1.6, 0.05, 0), new THREE.Vector3(0, 0, Math.PI / 2));
    addMesh(fuse, new THREE.SphereGeometry(0.32, 24, 18, 0, Math.PI * 2, 0, Math.PI / 2), matGlass, new THREE.Vector3(1.22, 0.12, 0), new THREE.Vector3(0, 0, 0));

    // Крылья
    const wingGeo = new THREE.BoxGeometry(2.1, 0.09, 3.8);
    const leftWing = addMesh(fuse, wingGeo, matCamo, new THREE.Vector3(0.1, -0.18, -1.55), new THREE.Vector3(0, 0, 0.03));
    const rightWing = addMesh(fuse, wingGeo, matCamo, new THREE.Vector3(0.1, -0.18, 1.55), new THREE.Vector3(0, 0, -0.03));
    const leftAileron = addMesh(fuse, new THREE.BoxGeometry(0.6, 0.05, 0.9), matDark, new THREE.Vector3(0.1, -0.12, -2.0), new THREE.Vector3(0, 0, 0));
    const rightAileron = addMesh(fuse, new THREE.BoxGeometry(0.6, 0.05, 0.9), matDark, new THREE.Vector3(0.1, -0.12, 2.0), new THREE.Vector3(0, 0, 0));

    // Хвост
    const tail = new THREE.Group();
    tail.position.set(-2.0, 0.1, 0);
    droneGroup.add(tail);
    addMesh(tail, new THREE.BoxGeometry(0.75, 0.06, 1.1), matBody, new THREE.Vector3(0.3, 0.2, -0.8), new THREE.Vector3(0.4, 0, 0));
    addMesh(tail, new THREE.BoxGeometry(0.75, 0.06, 1.1), matBody, new THREE.Vector3(0.3, 0.2, 0.8), new THREE.Vector3(-0.4, 0, 0));
    const rudderL = addMesh(tail, new THREE.BoxGeometry(0.25, 0.05, 0.8), matDark, new THREE.Vector3(0.65, 0.25, -0.8), new THREE.Vector3(0, 0, 0));
    const rudderR = addMesh(tail, new THREE.BoxGeometry(0.25, 0.05, 0.8), matDark, new THREE.Vector3(0.65, 0.25, 0.8), new THREE.Vector3(0, 0, 0));

    // Двигатель и пропеллер
    const engine = new THREE.Group();
    engine.position.set(-2.9, -0.05, 0);
    droneGroup.add(engine);
    addMesh(engine, new THREE.CylinderGeometry(0.38, 0.38, 0.85, 24), matDark, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, Math.PI / 2));
    const propeller = new THREE.Group();
    engine.add(propeller);
    const bladeGeo = new THREE.BoxGeometry(0.1, 1.35, 0.06);
    addMesh(propeller, bladeGeo, matProp, new THREE.Vector3(0.1, 0.68, 0), new THREE.Vector3(0, 0, 0.2));
    addMesh(propeller, bladeGeo, matProp, new THREE.Vector3(0.1, -0.68, 0), new THREE.Vector3(0, 0, -0.2));

    // Огни
    addMesh(fuse, new THREE.SphereGeometry(0.06, 8, 8), matRed, new THREE.Vector3(0.5, -0.22, 2.15), new THREE.Vector3(0, 0, 0));
    addMesh(fuse, new THREE.SphereGeometry(0.06, 8, 8), matGreen, new THREE.Vector3(0.5, -0.22, -2.15), new THREE.Vector3(0, 0, 0));

    // --------------------- АНИМАЦИЯ ---------------------
    let lastTime = performance.now();
    let animFrame;
    let propellerAngle = 0;

    const animate = () => {
      const now = performance.now();
      let dt = Math.min(0.033, (now - lastTime) / 1000);
      lastTime = now;
      if (dt < 0.003) dt = 0.016;

      if (flightActive) {
        const inputs = inputState.current;
        const isBoost = false; // можно сделать по Shift, но не просили – оставим
        setBoostActive(isBoost);
        const { throttle, speed, aoa, vertical } = physicsRef.current.update(dt, inputs, isBoost);
        
        droneGroup.position.copy(physicsRef.current.pos);
        droneGroup.rotation.copy(physicsRef.current.rot);
        
        propellerAngle += (0.25 + throttle * 2.5) * dt * 30;
        propeller.rotation.x = propellerAngle;
        
        // Анимация рулей
        const rollInp = (inputs.ArrowRight ? 1 : inputs.ArrowLeft ? -1 : 0);
        leftAileron.rotation.z = rollInp * 0.35;
        rightAileron.rotation.z = -rollInp * 0.35;
        const pitchInp = (inputs.ArrowUp ? 1 : inputs.ArrowDown ? -1 : 0);
        rudderL.rotation.x = pitchInp * 0.3;
        rudderR.rotation.x = pitchInp * 0.3;
        
        // Звук
        audioRef.current.update(throttle, speed / 130, isBoost, vertical);
        
        const alt = (physicsRef.current.pos.y + 2.2).toFixed(1);
        setHudData({
          alt, spd: speed.toFixed(0), thr: (throttle * 100).toFixed(0),
          pitch: (physicsRef.current.rot.x * 180 / Math.PI).toFixed(1),
          roll: (physicsRef.current.rot.z * 180 / Math.PI).toFixed(1),
          aoa: aoa.toFixed(1)
        });
        
        // Камеры
        if (camMode === 'follow') {
          const targetOffset = new THREE.Vector3(-7, 2.5, 0).applyEuler(new THREE.Euler(0, physicsRef.current.rot.y, 0));
          camera.position.lerp(physicsRef.current.pos.clone().add(targetOffset), 5 * dt);
          camera.lookAt(physicsRef.current.pos.clone().add(new THREE.Vector3(3, 0, 0).applyEuler(physicsRef.current.rot)));
          orbitControls.enabled = false;
        } else if (camMode === 'fpv') {
          const nosePos = physicsRef.current.pos.clone().add(new THREE.Vector3(1.6, 0.15, 0).applyEuler(physicsRef.current.rot));
          camera.position.copy(nosePos);
          camera.rotation.copy(physicsRef.current.rot);
          camera.rotateY(-Math.PI / 2);
          orbitControls.enabled = false;
        } else {
          orbitControls.enabled = true;
          orbitControls.target.lerp(physicsRef.current.pos, 0.1);
          orbitControls.update();
        }
        
        // Бесконечная земля
        groundPlane.position.x = Math.round(physicsRef.current.pos.x / 500) * 500;
        groundPlane.position.z = Math.round(physicsRef.current.pos.z / 500) * 500;
        gridHelper.position.x = groundPlane.position.x;
        gridHelper.position.z = groundPlane.position.z;
      } else {
        droneGroup.position.set(0, 1.2 + Math.sin(Date.now() * 0.002) * 0.1, 0);
        droneGroup.rotation.set(0, Date.now() * 0.001, 0);
        propellerAngle += 0.08;
        propeller.rotation.x = propellerAngle;
        camera.position.set(8, 4, 12);
        camera.lookAt(0, 0.8, 0);
        orbitControls.enabled = true;
        orbitControls.target.set(0, 0.8, 0);
        orbitControls.update();
      }
      renderer.render(scene, camera);
      animFrame = requestAnimationFrame(animate);
    };
    animate();

    const handleResize = () => {
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener('resize', handleResize);
    return () => {
      cancelAnimationFrame(animFrame);
      window.removeEventListener('resize', handleResize);
      renderer.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
    };
  }, [flightActive, camMode]);

  // ----------------------------- 6. UI -----------------------------
  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', overflow: 'hidden' }} onClick={handleFirstClick}>
      <div ref={mountRef} style={{ width: '100%', height: '100%' }} />
      {!flightActive && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.8)',
          backdropFilter: 'blur(8px)', zIndex: 10
        }}>
          <h1 style={{ color: '#aaf0ff', fontSize: 58 }}>«ЛЮТЫЙ»</h1>
          <p style={{ color: '#8ab0cc', marginBottom: 40 }}>Ударный БПЛА – новое управление WASD + Space (вверх) / Ctrl (вниз)</p>
          <button onClick={startFlight} style={{
            background: '#1a4a2a', border: '2px solid #2ecc71', color: '#ccffcc',
            fontSize: 28, padding: '16px 48px', cursor: 'pointer', borderRadius: 60
          }}>АВТОРИЗАЦИЯ ПОЛЁТА</button>
        </div>
      )}
      {flightActive && (
        <>
          <div style={{ position: 'absolute', top: 20, left: 20, background: 'rgba(0,0,0,0.6)', padding: 16, borderRadius: 12, color: '#bbffcc', fontFamily: 'monospace', zIndex: 20 }}>
            <div>ВЫСОТА: {hudData.alt} м</div>
            <div>СКОРОСТЬ: {hudData.spd} км/ч</div>
            <div>ТЯГА: {hudData.thr}%</div>
            <div>ТАНГАЖ: {hudData.pitch}° | КРЕН: {hudData.roll}°</div>
            <div>УГОЛ АТАКИ: {hudData.aoa}°</div>
          </div>
          <div style={{ position: 'absolute', bottom: 20, right: 20, background: 'rgba(0,0,0,0.5)', padding: 8, borderRadius: 8, color: '#aaa', fontSize: 12 }}>
            WASD – движение | Space/Ctrl – вверх/вниз | C – камера | R – сброс
          </div>
        </>
      )}
    </div>
  );
}
