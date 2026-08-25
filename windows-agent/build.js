// Compila el agente dejando la version en el nombre del archivo.
//
// El nombre es la unica forma confiable de saber que version es un ejecutable
// empaquetado con pkg: adentro el codigo va como bytecode, y un binario de 37 MB
// con Node incluido trae las versiones de todas sus dependencias, asi que
// buscarla ahi no discrimina.
//
// Con la version en el nombre, el panel la completa solo al elegir el archivo, y
// ademas se ve al momento de elegirlo, que es donde se origino el error de subir
// un ejecutable viejo declarando una version nueva.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const paquete = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const version = paquete.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`La version de package.json no tiene el formato x.y.z: "${version}"`);
  process.exit(1);
}

// El numero de package.json y el que reporta el agente tienen que ser el mismo:
// si se separan, el servidor ofrece una version que el agente nunca alcanza y
// queda pidiendo la actualizacion en cada latido.
const fuente = fs.readFileSync(path.join(__dirname, 'agent.js'), 'utf8');
const enCodigo = (fuente.match(/AGENT_VERSION\s*=\s*'([^']+)'/) || [])[1];
if (enCodigo !== version) {
  console.error(`Descalce de versiones: package.json dice ${version} y agent.js dice ${enCodigo}.`);
  console.error('Los dos tienen que coincidir antes de compilar.');
  process.exit(1);
}

const salida = path.join(__dirname, 'dist', `ServerEyes-Agent-${version}.exe`);
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });

console.log(`Compilando ServerEyes Agent ${version}...`);
execFileSync('npx', ['pkg', 'agent.js', '--target', 'node18-win-x64', '--output', salida],
  { cwd: __dirname, stdio: 'inherit', shell: true });

const sha = require('crypto').createHash('sha256').update(fs.readFileSync(salida)).digest('hex');
console.log(`\n  ${salida}`);
console.log(`  ${fs.statSync(salida).size} bytes`);
console.log(`  sha256 ${sha}`);
console.log(`\nSubi ESE archivo al panel. El nombre ya lleva la version, asi que se completa sola.`);
