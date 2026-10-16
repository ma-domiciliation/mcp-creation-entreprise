import { spawn } from 'node:child_process'

// Ouvre une URL dans le navigateur par défaut de la machine (le serveur MCP tourne en local).
// Évite à l'utilisateur de copier un lien long depuis le terminal (les URL coupées à la ligne
// ont déjà provoqué un « Token invalide » en QA).
const openUrl = url => new Promise((resolve, reject) => {
  if (!/^https?:\/\//.test(url)) return reject(new Error('URL invalide'))
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
  child.on('error', reject)
  child.on('spawn', () => { child.unref(); resolve(true) })
})

export { openUrl }
