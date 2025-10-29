// ===== server.js  =====
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
    "http://localhost:3000",
    "http://localhost:3001"
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
console.log('🔌 Tentando conectar ao MySQL...');
pool.getConnection()
  .then(connection => {
    console.log('✅ Conectado ao MySQL com sucesso!');
    connection.release();
  })
  .catch(err => {
    console.error('❌ Erro ao conectar no MySQL:', err.message);
  });

// ===== ROTA DE LOGIN =====
app.post('/api/login', async (req, res) => {
  try {
    const { cpf, senha } = req.body;
    const cpfLimpo = cpf.replace(/\D/g, '');

    const [proprietarios] = await pool.query(
      'SELECT id, nome, cpf FROM proprietarios WHERE cpf = ? AND senha = ?',
      [cpfLimpo, senha]
    );

    if (proprietarios.length === 0) {
      return res.status(401).json({ error: 'CPF ou senha incorretos' });
    }

    const proprietario = proprietarios[0];

    const [academias] = await pool.query(`
      SELECT a.id, a.nome
      FROM academia a
      INNER JOIN proprietarios_academias pa ON a.id = pa.id_academia
      WHERE pa.id_proprietario = ?
    `, [proprietario.id]);

  

    res.json({
  id: proprietario.id,
  nome: proprietario.nome,
  cpf: proprietario.cpf,
  academias: academias
  });
  
  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

// ===== FUNÇÃO PARA BUSCAR DADOS DO DASHBOARD =====
async function getDashboardData(academiaId) {
  try {
    // 🔧 MODIFICAÇÃO: Buscar qtd_alunos_ativo da tabela academia
    const [academiaResult] = await pool.query(`
      SELECT qtd_alunos_ativo
      FROM academia
      WHERE id = ?
    `, [academiaId]);
    
    const totalMembros = academiaResult[0]?.qtd_alunos_ativo || 0;

    const [receitaResult] = await pool.query(`
      SELECT SUM(valor) as total
      FROM recebimentos_mensalidades
      WHERE id_academia = ?
      AND MONTH(data) = MONTH(CURDATE())
      AND YEAR(data) = YEAR(CURDATE())
    `, [academiaId]);
    const receitaMensal = parseFloat(receitaResult[0]?.total || 0);

    const [mesAnteriorResult] = await pool.query(`
      SELECT qtd_alunos_ativo as total
      FROM academia
      WHERE id = ?
    `, [academiaId]);
    const membrosMesAnterior = mesAnteriorResult[0]?.total || 1;
    const crescimento = ((totalMembros - membrosMesAnterior) / membrosMesAnterior * 100).toFixed(1);

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

// ===== DASHBOARD CONSOLIDADO =====
app.get('/api/academias/dashboard-consolidado', async (req, res) => {
  try {
    const { ids, datainicio, datafim } = req.query;

    console.log('=== DEBUG DASHBOARD CONSOLIDADO ===');
    console.log('IDs recebidos:', ids);
    console.log('Data início:', datainicio);
    console.log('Data fim:', datafim);

    if (!ids || !datainicio || !datafim) {
      return res.status(400).json({ erro: 'ids, datainicio e datafim são obrigatórios' });
    }

    const academiaIds = ids.split(',').map(id => parseInt(id));

    // 🔧 MODIFICAÇÃO: Somar qtd_alunos_ativo de todas as academias
    const [membrosResult] = await pool.query(`
      SELECT SUM(qtd_alunos_ativo) as total
      FROM academia
      WHERE id IN (?)
    `, [academiaIds]);
    
    const totalMembros = membrosResult[0]?.total || 0;

    const [receitaResult] = await pool.query(`
      SELECT COALESCE(SUM(valor), 0) as total
      FROM recebimentos_mensalidades
      WHERE id_academia IN (?)
      AND DATE(data) >= DATE(?) 
      AND DATE(data) <= DATE(?)
    `, [academiaIds, datainicio, datafim]);
    
    const receitaMensal = parseFloat(receitaResult[0]?.total || 0);

    const [receitaDiariaResult] = await pool.query(`
      SELECT COALESCE(SUM(valor), 0) as receitaDiaria
      FROM recebimentos_mensalidades
      WHERE id_academia IN (?)
      AND DATE(data) = CURDATE()
    `, [academiaIds]);
    
    const receitaDiaria = parseFloat(receitaDiariaResult[0]?.receitaDiaria || 0);

    const [receitasPorMes] = await pool.query(`
      SELECT
        DATE_FORMAT(data, '%b') as mes,
        COALESCE(SUM(valor), 0) as receita,
        COUNT(DISTINCT id_original) as membros
      FROM recebimentos_mensalidades
      WHERE id_academia IN (?)
      AND DATE(data) >= DATE(?) 
      AND DATE(data) <= DATE(?)
      GROUP BY YEAR(data), MONTH(data), DATE_FORMAT(data, '%b')
      ORDER BY YEAR(data) ASC, MONTH(data) ASC
    `, [academiaIds, datainicio, datafim]);

    const [receitasPorFormaPgto] = await pool.query(`
      SELECT
        COALESCE(forma_pgto, 'NÃO INFORMADO') as nome,
        COALESCE(SUM(valor), 0) as valor,
        COUNT(*) as quantidade
      FROM recebimentos_mensalidades
      WHERE id_academia IN (?)
      AND DATE(data) >= DATE(?) 
      AND DATE(data) <= DATE(?)
      AND forma_pgto IS NOT NULL
      AND forma_pgto != ''
      GROUP BY forma_pgto
      ORDER BY valor DESC
    `, [academiaIds, datainicio, datafim]);

    const [planosAtivos] = await pool.query(`
      SELECT
        COALESCE(atividades, 'SEM PLANO') as plano,
        COUNT(DISTINCT id_original) as clientes,
        COALESCE(SUM(valor), 0) as receita
      FROM recebimentos_mensalidades
      WHERE id_academia IN (?)
      AND DATE(data) >= DATE(?) 
      AND DATE(data) <= DATE(?)
      AND atividades IS NOT NULL
      AND atividades != ''
      GROUP BY atividades
      ORDER BY receita DESC
    `, [academiaIds, datainicio, datafim]);

    const [pagamentosRecentes] = await pool.query(`
      SELECT
        id,
        nome,
        valor,
        forma_pgto,
        DATE_FORMAT(data, '%Y-%m-%d') as data,
        COALESCE(tipo_cliente, 'RENOVAÇÃO') as tipo
      FROM recebimentos_mensalidades
      WHERE id_academia IN (?)
      AND DATE(data) >= DATE(?) 
      AND DATE(data) <= DATE(?)
      ORDER BY data DESC, hora DESC
      LIMIT 20
    `, [academiaIds, datainicio, datafim]);

    const [clientesNovos] = await pool.query(`
      SELECT 
        id,
        id_original,
        nome,
        atividade,
        DATE_FORMAT(data, '%Y-%m-%d') as data,
        hora,
        id_academia
      FROM clientes_novos
      WHERE id_academia IN (?)
      AND DATE(data) >= DATE(?) 
      AND DATE(data) <= DATE(?)
      ORDER BY data DESC, hora DESC
      LIMIT 10
    `, [academiaIds, datainicio, datafim]);

    let clientesExcluidos = [];
    try {
      const [result] = await pool.query(`
        SELECT * FROM clientes_excluidos
        WHERE id_academia IN (?)
        AND DATE(data) >= DATE(?) 
        AND DATE(data) <= DATE(?)
        ORDER BY data DESC, hora DESC
        LIMIT 10
      `, [academiaIds, datainicio, datafim]);
      clientesExcluidos = result;
    } catch (error) {
      console.log('Tabela clientes_excluidos não existe:', error.message);
    }

    const [clientesNovosPorMes] = await pool.query(`
      SELECT
        DATE_FORMAT(data, '%b') as mes,
        COUNT(*) as quantidade
      FROM clientes_novos
      WHERE id_academia IN (?)
      AND DATE(data) >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
      GROUP BY YEAR(data), MONTH(data), DATE_FORMAT(data, '%b')
      ORDER BY YEAR(data) ASC, MONTH(data) ASC
    `, [academiaIds]);

    const response = {
      totalMembros,
      receitaMensal,
      receitaDiaria,
      crescimento: 0,
      receitasPorMes: receitasPorMes.map(r => ({
        mes: r.mes,
        receita: parseFloat(r.receita) || 0,
        membros: parseInt(r.membros) || 0
      })),
      receitasPorFormaPgto: receitasPorFormaPgto.map(r => ({
        nome: r.nome,
        valor: parseFloat(r.valor) || 0,
        quantidade: parseInt(r.quantidade) || 0
      })),
      planosAtivos: planosAtivos.map(p => ({
        plano: p.plano,
        clientes: parseInt(p.clientes) || 0,
        receita: parseFloat(p.receita) || 0
      })),
      pagamentosRecentes: pagamentosRecentes.map(p => ({
        id: p.id,
        nome: p.nome,
        valor: parseFloat(p.valor) || 0,
        forma_pgto: p.forma_pgto || 'NÃO INFORMADO',
        data: p.data,
        tipo: p.tipo
      })),
      clientesNovos: clientesNovos,
      clientesExcluidos: clientesExcluidos,
      clientesNovosPorMes: clientesNovosPorMes.map(c => ({
        mes: c.mes,
        quantidade: parseInt(c.quantidade) || 0
      })),
      periodoFiltrado: {
        datainicio,
        datafim
      }
    };

    console.log('✅ Resposta enviada com sucesso');
    console.log('✅ Total de alunos ativos (qtd_alunos_ativo):', totalMembros);
    res.json(response);

  } catch (error) {
    console.error('❌ ERRO ao buscar dados consolidados:', error);
    res.status(500).json({ 
      erro: 'Erro ao buscar dados consolidados', 
      detalhes: error.message 
    });
  }
});

// ===== DASHBOARD FILTRADO =====
app.get('/api/academia/:id/dashboard-filtrado', async (req, res) => {
  try {
    const academiaId = req.params.id;
    const { datainicio, datafim } = req.query;

    if (!datainicio || !datafim) {
      return res.status(400).json({ erro: 'datainicio e datafim são obrigatórios' });
    }

    // 🔧 MODIFICAÇÃO: Buscar qtd_alunos_ativo da tabela academia
    const [academiaResult] = await pool.query(`
      SELECT qtd_alunos_ativo
      FROM academia
      WHERE id = ?
    `, [academiaId]);
    
    const totalMembros = academiaResult[0]?.qtd_alunos_ativo || 0;

    const [receitaResult] = await pool.query(`
      SELECT SUM(valor) as total
      FROM recebimentos_mensalidades
      WHERE id_academia = ?
      AND DATE(data) >= DATE(?) AND DATE(data) <= DATE(?)
    `, [academiaId, datainicio, datafim]);
    const receitaMensal = parseFloat(receitaResult[0]?.total || 0);

    const [receitaDiariaResult] = await pool.query(`
      SELECT COALESCE(SUM(valor), 0) as receitaDiaria
      FROM recebimentos_diarias
      WHERE id_academia = ?
      AND DATE(data) = CURDATE()
    `, [academiaId]);
    const receitaDiaria = parseFloat(receitaDiariaResult[0]?.receitaDiaria || 0);

    const [receitasPorMes] = await pool.query(`
      SELECT
        DATE_FORMAT(data, '%b') as mes,
        SUM(valor) as receita,
        COUNT(DISTINCT id_original) as membros
      FROM recebimentos_mensalidades
      WHERE id_academia = ?
      AND DATE(data) >= DATE(?) AND DATE(data) <= DATE(?)
      GROUP BY YEAR(data), MONTH(data)
      ORDER BY data ASC
    `, [academiaId, datainicio, datafim]);

    const [receitasPorFormaPgto] = await pool.query(`
      SELECT
        forma_pgto as nome,
        SUM(valor) as valor,
        COUNT(*) as quantidade
      FROM recebimentos_mensalidades
      WHERE id_academia = ?
      AND DATE(data) >= DATE(?) AND DATE(data) <= DATE(?)
      AND forma_pgto IS NOT NULL
      AND forma_pgto != ''
      GROUP BY forma_pgto
      ORDER BY valor DESC
    `, [academiaId, datainicio, datafim]);

    const [planosAtivos] = await pool.query(`
      SELECT
        atividades as plano,
        COUNT(DISTINCT id_original) as clientes,
        SUM(valor) as receita
      FROM recebimentos_mensalidades
      WHERE id_academia = ?
      AND DATE(data) >= DATE(?) AND DATE(data) <= DATE(?)
      AND atividades IS NOT NULL
      AND atividades != ''
      GROUP BY atividades
      ORDER BY receita DESC
    `, [academiaId, datainicio, datafim]);

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
      AND DATE(data) >= DATE(?) AND DATE(data) <= DATE(?)
      ORDER BY data DESC, hora DESC
      LIMIT 20
    `, [academiaId, datainicio, datafim]);

    const [clientesNovos] = await pool.query(`
      SELECT * FROM clientes_novos
      WHERE id_academia = ?
      AND DATE(data) >= DATE(?) AND DATE(data) <= DATE(?)
      ORDER BY data DESC, hora DESC
      LIMIT 10
    `, [academiaId, datainicio, datafim]);

    const [clientesExcluidos] = await pool.query(`
      SELECT * FROM clientes_excluidos
      WHERE id_academia = ?
      AND DATE(data) >= DATE(?) AND DATE(data) <= DATE(?)
      ORDER BY data DESC, hora DESC
      LIMIT 10
    `, [academiaId, datainicio, datafim]);

    const [clientesNovosPorMes] = await pool.query(`
      SELECT
        DATE_FORMAT(data, '%b') as mes,
        COUNT(*) as quantidade
      FROM clientes_novos
      WHERE id_academia = ?
      AND DATE(data) >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
      GROUP BY YEAR(data), MONTH(data)
      ORDER BY data ASC
    `, [academiaId]);

    res.json({
      totalMembros,
      receitaMensal,
      receitaDiaria,
      crescimento: 0,
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
      })),
      clientesNovos: clientesNovos,
      clientesExcluidos: clientesExcluidos,
      clientesNovosPorMes: clientesNovosPorMes.map(c => ({
        mes: c.mes,
        quantidade: c.quantidade
      })),
      periodoFiltrado: {
        datainicio,
        datafim
      }
    });

  } catch (error) {
    console.error('Erro ao buscar dashboard filtrado:', error);
    res.status(500).json({ erro: 'Erro ao buscar dados do dashboard' });
  }
});

// ===== RELATÓRIOS CONSOLIDADOS (DEVEM VIR ANTES DAS ROTAS INDIVIDUAIS) =====
// ... (resto do código permanece igual, incluindo todas as rotas de relatórios)

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
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`✅ API disponível em http://localhost:${PORT}/api/test`);
});

// ===== TRATAMENTO DE ERROS =====
process.on('unhandledRejection', (error) => {
  console.error('❌ Erro não tratado:', error);
});