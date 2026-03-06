# BlackBox Trading Journal

## Deploy en Vercel (5 minutos)

### 1. Sube a GitHub
```bash
git init
git add .
git commit -m "BlackBox Trading Journal"
git remote add origin https://github.com/TU_USUARIO/blackbox-trading.git
git push -u origin main
```

### 2. Importa en Vercel
1. Ve a https://vercel.com/new
2. Importa tu repositorio de GitHub
3. Clic en "Deploy" (sin cambiar nada)

### 3. Configura la API key
En Vercel → Tu proyecto → Settings → Environment Variables:
- Nombre: `ANTHROPIC_API_KEY`
- Valor: tu API key de Anthropic (sk-ant-...)
- Clic en Save

### 4. Redeploy
En Vercel → Deployments → clic en los 3 puntos → Redeploy

### Tu URL
`https://blackbox-trading.vercel.app` (o el nombre que Vercel asigne)

## Variables de entorno requeridas
| Variable | Descripción |
|---|---|
| `ANTHROPIC_API_KEY` | API key de Anthropic para el Coach IA |

## Estructura
```
blackbox-vercel/
├── api/
│   └── coach.js        ← Proxy seguro para Anthropic
├── public/
│   └── index.html      ← BlackBox app completa
├── vercel.json
└── package.json
```
