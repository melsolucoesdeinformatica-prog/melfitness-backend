# Mel Fitness - Backend API

Sistema de gestão para academias - API REST em Node.js

##  Tecnologias

- Node.js
- Express
- MySQL
- CORS

##  Pré-requisitos

- Node.js instalado (versão 14 ou superior)
- MySQL instalado e rodando
- NPM ou Yarn

##  Instalação

1. Clone o repositório
```bash
git clone https://github.com/SEU_USUARIO/melfitness-backend.git
cd melfitness-backend
```

2. Instale as dependências
```bash
npm install
```

3. Configure as variáveis de ambiente

Crie um arquivo `.env` na raiz do projeto com as seguintes variáveis:
```env
DB_HOST=localhost
DB_USER=seu_usuario
DB_PASSWORD=sua_senha
DB_NAME=mels06
PORT=3001
```

## ▶ Como executar

### Desenvolvimento
```bash
npm run dev
```

### Produção
```bash
npm start
```

O servidor estará rodando em `http://localhost:3001`

##  Endpoints da API

### Autenticação
- `POST /api/login` - Login de usuário

### Academias
- `GET /api/academias` - Lista todas as academias do usuário

### Dashboard
- `GET /api/dashboard/:academiaId` - Dados do dashboard

##  Estrutura do Banco de Dados

### Tabelas principais:
- `users` - Usuários do sistema
- `academias` - Cadastro de academias
- `clientes` - Clientes das academias
- `pagamentos` - Controle de pagamentos
- `planos` - Planos de assinatura

##  Segurança

- Nunca commite o arquivo `.env`
- Use senhas fortes para o banco de dados
- Configure CORS adequadamente para produção

## Variáveis de Ambiente

| Variável | Descrição | Exemplo |
|----------|-----------|---------|
| DB_HOST | Host do MySQL | localhost ou mysql.seudominio.com.br |
| DB_USER | Usuário do banco | root ou mels06 |
| DB_PASSWORD | Senha do banco | sua_senha_segura |
| DB_NAME | Nome do banco de dados | mels06 |
| PORT | Porta do servidor | 3001 |

##  Deploy

### Hospedagem sugerida:
- **Backend:** Render.com, Railway, Heroku ou VPS
- **Banco de dados:** MySQL na hospedagem ou serviço gerenciado

##  Autor

Mel Fitness Team

##  Licença

Todos os direitos reservados - 2025