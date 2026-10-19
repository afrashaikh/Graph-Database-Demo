# Graph Database Demo
Express + Neo4j API with React graph frontend.

## Prerequisites
- Node.js (v18+)
- Docker & Docker Compose

## Project Structure
- `/` - Express backend API
- `/frontend` - Vite + React graph visualizer & semantic search client

## Setup & Running

### Database Setup
Start the local ArangoDB container: 
``` 
bash 
docker compose up -d
```

Web UI: Visit `http://localhost:8529`
Default User: root 
Password: Defined in docker-compose.yml

### Backend Setup
1. Go to terminal and type `npm install`
2. Copy .env.example to .env and configure it
3. Type `npm start`
4. Load in the sample data once in another terminal: `curl -X POST http://localhost:3000/api/seed`

### Frontend Setup
1. Open another terminal tab and type `cd frontend`
2. Type in terminal `npm install` 
3. Start the development server with `npm run dev`
4. Open `http://localhost:5173` in browser.

## Features 
- Force Graph Canvas using react-force-graph-2d
- Node and link management 
- Visual neighbor focus
- Semantic Search using Transformers.js and cosine similarity
