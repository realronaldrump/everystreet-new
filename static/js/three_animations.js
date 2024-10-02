// three_animations.js

let backgroundScene, backgroundCamera, backgroundRenderer;
let metricsScene, metricsCamera, metricsRenderer;

function initBackgroundAnimation() {
    backgroundScene = new THREE.Scene();
    backgroundCamera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    backgroundRenderer = new THREE.WebGLRenderer({ alpha: true });
    backgroundRenderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(backgroundRenderer.domElement);

    const geometry = new THREE.TorusKnotGeometry(10, 3, 100, 16);
    const material = new THREE.MeshBasicMaterial({ color: 0x6200ee, wireframe: true });
    const torusKnot = new THREE.Mesh(geometry, material);
    backgroundScene.add(torusKnot);

    backgroundCamera.position.z = 30;

    function animateBackground() {
        requestAnimationFrame(animateBackground);
        torusKnot.rotation.x += 0.01;
        torusKnot.rotation.y += 0.01;
        backgroundRenderer.render(backgroundScene, backgroundCamera);
    }
    animateBackground();
}

function initMetricsAnimation() {
    metricsScene = new THREE.Scene();
    metricsCamera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
    metricsRenderer = new THREE.WebGLRenderer({ alpha: true });
    metricsRenderer.setSize(200, 200);
    document.getElementById('metrics').appendChild(metricsRenderer.domElement);

    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshBasicMaterial({ color: 0x03dac6 });
    const cube = new THREE.Mesh(geometry, material);
    metricsScene.add(cube);

    metricsCamera.position.z = 5;

    function animateMetrics() {
        requestAnimationFrame(animateMetrics);
        cube.rotation.x += 0.01;
        cube.rotation.y += 0.01;
        metricsRenderer.render(metricsScene, metricsCamera);
    }
    animateMetrics();
}

// Resize event listener
window.addEventListener('resize', onWindowResize, false);

function onWindowResize() {
    backgroundCamera.aspect = window.innerWidth / window.innerHeight;
    backgroundCamera.updateProjectionMatrix();
    backgroundRenderer.setSize(window.innerWidth, window.innerHeight);
}