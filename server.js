// ===== INSTALAÇÃO =====
// npm init -y
// npm install express mysql2 cors dotenv

// ===== .env =====
// DB_HOST=localhost
// DB_USER=root
// DB_PASSWORD=sua_senha
// DB_NAME=mels06
// PORT=3001

// ===== server.js =====
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middlewares
app.use(cors({
  origin: [
    "http://melgdrive.kinghost.net",  
    "https://melgdrive.kinghost.net",  
    "http://localhost:3000"
  ],
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true
}));

app.use(express.json());

// Configuração do pool de conexões MySQL
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'mysql.mels.com.br',
  user: process.env.DB_USER || 'mels06',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'mels06',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});
// Testar conexão com o banco
console.log('🔍 Tentando conectar ao MySQL...');
console.log('Host:', process.env.DB_HOST);
console.log('User:', process.env.DB_USER);
console.log('Database:', process.env.DB_NAME);

pool.getConnection()
  .then(connection => {
    console.log(' Conectado ao MySQL com sucesso!');
    connection.release();
  })
  .catch(err => {
    console.error(' Erro ao conectar no MySQL:', err.message);
    console.error('Código do erro:', err.code);
  });

// ===== ROTA DE LOGIN =====
app.post('/api/login', async (req, res) => {
  try {
    const { cpf, senha } = req.body;

    // Remove formatação do CPF
    const cpfLimpo = cpf.replace(/\D/g, '');

    // 1. Buscar proprietário
    const [proprietarios] = await pool.query(
      'SELECT id, nome, cpf FROM proprietarios WHERE cpf = ? AND senha = ?',
      [cpfLimpo, senha]
    );

    if (proprietarios.length === 0) {
      return res.status(401).json({ error: 'CPF ou senha incorretos' });
    }

    const proprietario = proprietarios[0];

    // 2. Buscar academias do proprietário
    const [academias] = await pool.query(`
      SELECT a.id, a.nome 
      FROM academia a
      INNER JOIN proprietarios_academias pa ON a.id = pa.id_academia
      WHERE pa.id_proprietario = ?
    `, [proprietario.id]);

    // 3. Para cada academia, buscar dados do dashboard
    const academiasComDados = await Promise.all(
      academias.map(async (academia) => {
        const dashboardData = await getDashboardData(academia.id);
        return {
          ...academia,
          ...dashboardData
        };
      })
    );

    res.json({
      id: proprietario.id,
      nome: proprietario.nome,
      cpf: proprietario.cpf,
      academias: academiasComDados
    });

  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});
    // Rota para buscar clientes novos
app.get('/api/clientes-novos/:academiaId', async (req, res) => {
  try {
    const { academiaId } = req.params;
    const [rows] = await pool.query(
      'SELECT * FROM clientes_novos WHERE id_academia = ? ORDER BY data DESC, hora DESC LIMIT 10',
      [academiaId]
    );
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar clientes novos:', error);
    res.status(500).json({ erro: 'Erro ao buscar clientes novos' });
  }
});

// Rota para buscar clientes excluídos
app.get('/api/clientes-excluidos/:academiaId', async (req, res) => {
  try {
    const { academiaId } = req.params;
    const [rows] = await pool.query(
      'SELECT * FROM clientes_excluidos WHERE id_academia = ? ORDER BY data DESC, hora DESC LIMIT 10',
      [academiaId]
    );
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar clientes excluídos:', error);
    res.status(500).json({ erro: 'Erro ao buscar clientes excluídos' });
  }
});

app.get('/api/receita-diaria/:academiaId', async (req, res) => {
  try {
    const { academiaId } = req.params;
    const hoje = new Date().toISOString().split('T')[0]; // Data de hoje YYYY-MM-DD
    
    const [rows] = await pool.query(
      `SELECT COALESCE(SUM(valor), 0) as receitaDiaria 
       FROM recebimentos_diarias 
       WHERE id_academia = ? AND DATE(data) = ?`,
      [academiaId, hoje]
    );
    
    res.json({ receitaDiaria: parseFloat(rows[0].receitaDiaria) });
  } catch (error) {
    console.error('Erro ao buscar receita diária:', error);
    res.status(500).json({ erro: 'Erro ao buscar receita diária' });
  }
});
// ===== FUNÇÃO PARA BUSCAR DADOS DO DASHBOARD =====
async function getDashboardData(academiaId) {
  try {
    // 1. Total de membros ativos (baseado em clientes_novos ou frequencia)
    const [membrosResult] = await pool.query(`
      SELECT COUNT(DISTINCT id_original) as total
      FROM recebimentos_mensalidades
      WHERE id_academia = ? 
      AND MONTH(data) = MONTH(CURDATE())
      AND YEAR(data) = YEAR(CURDATE())
    `, [academiaId]);
    const totalMembros = membrosResult[0]?.total || 0;

    // 2. Receita mensal
    const [receitaResult] = await pool.query(`
      SELECT SUM(valor) as total
      FROM recebimentos_mensalidades
      WHERE id_academia = ? 
      AND MONTH(data) = MONTH(CURDATE())
      AND YEAR(data) = YEAR(CURDATE())
    `, [academiaId]);
    const receitaMensal = parseFloat(receitaResult[0]?.total || 0);

    // 3. Crescimento (comparar com mês anterior)
    const [mesAnteriorResult] = await pool.query(`
      SELECT COUNT(DISTINCT id_original) as total
      FROM recebimentos_mensalidades
      WHERE id_academia = ? 
      AND MONTH(data) = MONTH(DATE_SUB(CURDATE(), INTERVAL 1 MONTH))
      AND YEAR(data) = YEAR(DATE_SUB(CURDATE(), INTERVAL 1 MONTH))
    `, [academiaId]);
    const membrosMesAnterior = mesAnteriorResult[0]?.total || 1;
    const crescimento = ((totalMembros - membrosMesAnterior) / membrosMesAnterior * 100).toFixed(1);

    // 4. Receita por mês (últimos 4 meses)
    const [receitasPorMes] = await pool.query(`
      SELECT 
        DATE_FORMAT(data, '%b') as mes,
        SUM(valor) as receita,
        COUNT(DISTINCT id_original) as membros
      FROM recebimentos_mensalidades
      WHERE id_academia = ? 
      AND data >= DATE_SUB(CURDATE(), INTERVAL 4 MONTH)
      GROUP BY YEAR(data), MONTH(data)
      ORDER BY data ASC
    `, [academiaId]);

    // 5. Receita por forma de pagamento
    const [receitasPorFormaPgto] = await pool.query(`
      SELECT 
        forma_pgto as nome,
        SUM(valor) as valor,
        COUNT(*) as quantidade
      FROM recebimentos_mensalidades
      WHERE id_academia = ? 
      AND MONTH(data) = MONTH(CURDATE())
      AND YEAR(data) = YEAR(CURDATE())
      AND forma_pgto IS NOT NULL
      AND forma_pgto != ''
      GROUP BY forma_pgto
      ORDER BY valor DESC
    `, [academiaId]);

    // 6. Planos ativos
    const [planosAtivos] = await pool.query(`
      SELECT 
        atividades as plano,
        COUNT(DISTINCT id_original) as clientes,
        SUM(valor) as receita
      FROM recebimentos_mensalidades
      WHERE id_academia = ? 
      AND MONTH(data) = MONTH(CURDATE())
      AND YEAR(data) = YEAR(CURDATE())
      AND atividades IS NOT NULL
      AND atividades != ''
      GROUP BY atividades
      ORDER BY receita DESC
    `, [academiaId]);

    // 7. Pagamentos recentes (últimos 20)
    const [pagamentosRecentes] = await pool.query(`
      SELECT 
        id,
        nome,
        valor,
        forma_pgto,
        DATE_FORMAT(data, '%Y-%m-%d') as data,
        tipo_cliente as tipo
      FROM recebimentos_mensalidades
      WHERE id_academia = ?
      ORDER BY data DESC, hora DESC
      LIMIT 20
    `, [academiaId]);

    return {
      totalMembros,
      receitaMensal,
      crescimento: parseFloat(crescimento),
      receitasPorMes: receitasPorMes.map(r => ({
        mes: r.mes,
        receita: parseFloat(r.receita),
        membros: r.membros
      })),
      receitasPorFormaPgto: receitasPorFormaPgto.map(r => ({
        nome: r.nome,
        valor: parseFloat(r.valor),
        quantidade: r.quantidade
      })),
      planosAtivos: planosAtivos.map(p => ({
        plano: p.plano,
        clientes: p.clientes,
        receita: parseFloat(p.receita)
      })),
      pagamentosRecentes: pagamentosRecentes.map(p => ({
        id: p.id,
        nome: p.nome,
        valor: parseFloat(p.valor),
        forma_pgto: p.forma_pgto,
        data: p.data,
        tipo: p.tipo || 'RENOVAÇÃO'
      }))
    };

  } catch (error) {
    console.error('Erro ao buscar dados do dashboard:', error);
    return {
      totalMembros: 0,
      receitaMensal: 0,
      crescimento: 0,
      receitasPorMes: [],
      receitasPorFormaPgto: [],
      planosAtivos: [],
      pagamentosRecentes: []
    };
  }
}

// ===== ROTA PARA ATUALIZAR DADOS DE UMA ACADEMIA ESPECÍFICA =====
app.get('/api/academia/:id/dashboard', async (req, res) => {
  try {
    const academiaId = req.params.id;
    const dashboardData = await getDashboardData(academiaId);
    res.json(dashboardData);
  } catch (error) {
    console.error('Erro ao buscar dashboard:', error);
    res.status(500).json({ error: 'Erro ao buscar dados do dashboard' });
  }
});

// ===== ROTA DE TESTE =====
app.get('/api/test', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 + 1 AS result');
    res.json({ 
      status: 'OK', 
      database: 'Conectado',
      result: rows[0].result 
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'ERROR', 
      database: 'Erro na conexão',
      error: error.message 
    });
  }
});

// ===== INICIAR SERVIDOR =====
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(` Servidor rodando na porta ${PORT}`);
  console.log(` API disponível em http://localhost:${PORT}`);
  console.log(` Teste a conexão: http://localhost:${PORT}/api/test`);
});

// ===== TRATAMENTO DE ERROS =====
process.on('unhandledRejection', (error) => {
  console.error('Erro não tratado:', error);
});