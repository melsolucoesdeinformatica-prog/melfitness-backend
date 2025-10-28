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
console.log(' Tentando conectar ao MySQL...');
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

// ===== ROTA PARA BUSCAR CLIENTES NOVOS =====
app.get('/api/clientes-novos/:academiaid', async (req, res) => {
  try {
    const { academiaid } = req.params;
    const [rows] = await pool.query(
      'SELECT * FROM clientes_novos WHERE id_academia = ? ORDER BY data DESC, hora DESC LIMIT 10',
      [academiaid]
    );
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar clientes novos:', error);
    res.status(500).json({ erro: 'Erro ao buscar clientes novos' });
  }
});

// ===== ROTA PARA BUSCAR CLIENTES EXCLUÍDOS =====
app.get('/api/clientes-excluidos/:academiaid', async (req, res) => {
  try {
    const { academiaid } = req.params;
    const [rows] = await pool.query(
      'SELECT * FROM clientes_excluidos WHERE id_academia = ? ORDER BY data DESC, hora DESC LIMIT 10',
      [academiaid]
    );
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar clientes excluidos:', error);
    res.status(500).json({ erro: 'Erro ao buscar clientes excluídos' });
  }
});

// ===== ROTA PARA ATUALIZAR DADOS DE UMA ACADEMIA ESPECÍFICA =====
app.get('/api/academia/:id/dashboard', async (req, res) => {
  try {
    const academiaId = req.params.id;
    const dashboardData = await getDashboardData(academiaId);
    res.json(dashboardData);
  } catch (error) {
    console.error('Erro ao buscar dashboard:', error);
    res.status(500).json({ erro: 'Erro ao buscar dados do dashboard' });
  }
});

// ===== DASHBOARD CONSOLIDADO (MÚLTIPLAS ACADEMIAS) =====
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
    console.log('IDs convertidos:', academiaIds);

    // 1. Total de membros ativos
    const [membrosResult] = await pool.query(`
      SELECT COUNT(DISTINCT id_original) as total
      FROM recebimentos_mensalidades
      WHERE id_academia IN (?)
      AND DATE(data) >= DATE(?) 
      AND DATE(data) <= DATE(?)
    `, [academiaIds, datainicio, datafim]);
    
    const totalMembros = membrosResult[0]?.total || 0;

    // 2. Receita total consolidada
    const [receitaResult] = await pool.query(`
      SELECT COALESCE(SUM(valor), 0) as total
      FROM recebimentos_mensalidades
      WHERE id_academia IN (?)
      AND DATE(data) >= DATE(?) 
      AND DATE(data) <= DATE(?)
    `, [academiaIds, datainicio, datafim]);
    
    const receitaMensal = parseFloat(receitaResult[0]?.total || 0);

    // 3. Receita diária
    const [receitaDiariaResult] = await pool.query(`
      SELECT COALESCE(SUM(valor), 0) as receitaDiaria
      FROM recebimentos_mensalidades
      WHERE id_academia IN (?)
      AND DATE(data) = CURDATE()
    `, [academiaIds]);
    
    const receitaDiaria = parseFloat(receitaDiariaResult[0]?.receitaDiaria || 0);

    // 4. Receitas por mês
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

    // 5. Receita por forma de pagamento
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

    // 6. Planos ativos
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

    // 7. Pagamentos recentes
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

    // 8. Clientes novos
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

    // 9. Clientes excluídos
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

    // 10. Clientes novos por mês
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
    res.json(response);

  } catch (error) {
    console.error('❌ ERRO ao buscar dados consolidados:', error);
    res.status(500).json({ 
      erro: 'Erro ao buscar dados consolidados', 
      detalhes: error.message 
    });
  }
});

// ===== DASHBOARD FILTRADO (ACADEMIA INDIVIDUAL) =====
app.get('/api/academia/:id/dashboard-filtrado', async (req, res) => {
  try {
    const academiaId = req.params.id;
    const { datainicio, datafim } = req.query;

    console.log('=== DEBUG DASHBOARD FILTRADO ===');
    console.log('Academia ID:', academiaId);
    console.log('Data início:', datainicio);
    console.log('Data fim:', datafim);

    if (!datainicio || !datafim) {
      return res.status(400).json({ erro: 'datainicio e datafim são obrigatórios' });
    }

    // 1. Total de membros ativos
    const [membrosResult] = await pool.query(`
      SELECT COUNT(DISTINCT id_original) as total
      FROM recebimentos_mensalidades
      WHERE id_academia = ?
      AND DATE(data) >= DATE(?) AND DATE(data) <= DATE(?)
    `, [academiaId, datainicio, datafim]);
    const totalMembros = membrosResult[0]?.total || 0;

    // 2. Receita total
    const [receitaResult] = await pool.query(`
      SELECT SUM(valor) as total
      FROM recebimentos_mensalidades
      WHERE id_academia = ?
      AND DATE(data) >= DATE(?) AND DATE(data) <= DATE(?)
    `, [academiaId, datainicio, datafim]);
    const receitaMensal = parseFloat(receitaResult[0]?.total || 0);

    // 3. Receita diária
    const [receitaDiariaResult] = await pool.query(`
      SELECT COALESCE(SUM(valor), 0) as receitaDiaria
      FROM recebimentos_diarias
      WHERE id_academia = ?
      AND DATE(data) = CURDATE()
    `, [academiaId]);
    const receitaDiaria = parseFloat(receitaDiariaResult[0]?.receitaDiaria || 0);

    // 4. Receitas por mês
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

    // 5. Receita por forma de pagamento
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

    // 6. Planos ativos
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

    // 7. Pagamentos recentes
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

    // 8. Clientes novos
    const [clientesNovos] = await pool.query(`
      SELECT * FROM clientes_novos
      WHERE id_academia = ?
      AND DATE(data) >= DATE(?) AND DATE(data) <= DATE(?)
      ORDER BY data DESC, hora DESC
      LIMIT 10
    `, [academiaId, datainicio, datafim]);

    // 9. Clientes excluídos
    const [clientesExcluidos] = await pool.query(`
      SELECT * FROM clientes_excluidos
      WHERE id_academia = ?
      AND DATE(data) >= DATE(?) AND DATE(data) <= DATE(?)
      ORDER BY data DESC, hora DESC
      LIMIT 10
    `, [academiaId, datainicio, datafim]);

    // 10. Clientes novos por mês
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

// ===== RELATÓRIOS - ACADEMIA INDIVIDUAL =====

// 1. RELATÓRIO DE MENSALIDADES
app.get('/api/relatorio/mensalidades/:academiaid', async (req, res) => {
  try {
    const { academiaid } = req.params;
    const { datainicio, datafim } = req.query;

    console.log('=== RELATÓRIO MENSALIDADES (INDIVIDUAL) ===');
    console.log('Academia:', academiaid);
    console.log('Data início:', datainicio);
    console.log('Data fim:', datafim);

    let query = `
      SELECT 
        DATE_FORMAT(rm.data, '%Y-%m-%d') as data,
        rm.hora,
        rm.nome as cliente,
        rm.valor,
        rm.atividades as atividade,
        rm.forma_pgto,
        rm.tipo_cliente,
        rm.funcionario
      FROM recebimentos_mensalidades rm
      WHERE rm.id_academia = ?
    `;

    const params = [academiaid];

    if (datainicio && datafim) {
      query += ' AND DATE(rm.data) >= DATE(?) AND DATE(rm.data) <= DATE(?)';
      params.push(datainicio, datafim);
    }

    query += ' ORDER BY rm.data DESC, rm.hora DESC';

    const [rows] = await pool.query(query, params);
    console.log('Registros retornados:', rows.length);

    res.json(rows.map(row => ({
      data: row.data,
      hora: row.hora,
      cliente: row.cliente,
      valor: parseFloat(row.valor),
      atividade: row.atividade,
      forma_pgto: row.forma_pgto,
      tipo_cliente: row.tipo_cliente || 'RENOVAÇÃO',
      funcionario: row.funcionario
    })));

  } catch (error) {
    console.error('Erro ao buscar relatório de mensalidades:', error);
    res.status(500).json({ erro: 'Erro ao buscar relatório de mensalidades' });
  }
});

// 2. RELATÓRIO DE VENDAS
app.get('/api/relatorio/vendas/:academiaid', async (req, res) => {
  try {
    const { academiaid } = req.params;
    const { datainicio, datafim } = req.query;

    let query = `
      SELECT 
        DATE_FORMAT(rv.data, '%Y-%m-%d') as data,
        rv.hora,
        rv.cliente,
        rv.valor_total as valor,
        rv.produtos as atividade,
        rv.forma_pgto,
        'VENDA' as tipo_cliente,
        rv.funcionario
      FROM recebimentos_vendas rv
      WHERE rv.id_academia = ?
    `;

    const params = [academiaid];

    if (datainicio && datafim) {
      query += ' AND DATE(rv.data) >= DATE(?) AND DATE(rv.data) <= DATE(?)';
      params.push(datainicio, datafim);
    }

    query += ' ORDER BY rv.data DESC, rv.hora DESC';

    const [rows] = await pool.query(query, params);

    res.json(rows.map(row => ({
      data: row.data,
      hora: row.hora,
      cliente: row.cliente,
      valor: parseFloat(row.valor),
      atividade: row.atividade,
      forma_pgto: row.forma_pgto,
      tipo_cliente: row.tipo_cliente,
      funcionario: row.funcionario
    })));

  } catch (error) {
    console.error('Erro ao buscar relatório de vendas:', error);
    res.status(500).json({ erro: 'Erro ao buscar relatório de vendas' });
  }
});

// 3. RELATÓRIO DE AVALIAÇÕES
app.get('/api/relatorio/avaliacoes/:academiaid', async (req, res) => {
  try {
    const { academiaid } = req.params;
    const { datainicio, datafim } = req.query;

    let query = `
      SELECT 
        DATE_FORMAT(ra.data, '%Y-%m-%d') as data,
        ra.hora,
        ra.cliente,
        ra.valor,
        'AVALIAÇÃO FÍSICA' as atividade,
        '' as forma_pgto,
        'AVALIAÇÃO' as tipo_cliente,
        ra.funcionario
      FROM recebimentos_avaliacoes ra
      WHERE ra.id_academia = ?
    `;

    const params = [academiaid];

    if (datainicio && datafim) {
      query += ' AND DATE(ra.data) >= DATE(?) AND DATE(ra.data) <= DATE(?)';
      params.push(datainicio, datafim);
    }

    query += ' ORDER BY ra.data DESC, ra.hora DESC';

    const [rows] = await pool.query(query, params);

    res.json(rows.map(row => ({
      data: row.data,
      hora: row.hora,
      cliente: row.cliente,
      valor: parseFloat(row.valor),
      atividade: row.atividade,
      forma_pgto: row.forma_pgto,
      tipo_cliente: row.tipo_cliente,
      funcionario: row.funcionario
    })));

  } catch (error) {
    console.error('Erro ao buscar relatório de avaliações:', error);
    res.status(500).json({ erro: 'Erro ao buscar relatório de avaliações' });
  }
});

// 4. RELATÓRIO DE DIÁRIAS
app.get('/api/relatorio/diarias/:academiaid', async (req, res) => {
  try {
    const { academiaid } = req.params;
    const { datainicio, datafim } = req.query;

    let query = `
      SELECT 
        DATE_FORMAT(rd.data, '%Y-%m-%d') as data,
        rd.hora,
        rd.cliente,
        rd.valor,
        'DIÁRIA' as atividade,
        rd.forma_pgto,
        'DIÁRIA' as tipo_cliente,
        rd.funcionario
      FROM recebimentos_diarias rd
      WHERE rd.id_academia = ?
    `;

    const params = [academiaid];

    if (datainicio && datafim) {
      query += ' AND DATE(rd.data) >= DATE(?) AND DATE(rd.data) <= DATE(?)';
      params.push(datainicio, datafim);
    }

    query += ' ORDER BY rd.data DESC, rd.hora DESC';

    const [rows] = await pool.query(query, params);

    res.json(rows.map(row => ({
      data: row.data,
      hora: row.hora,
      cliente: row.cliente,
      valor: parseFloat(row.valor),
      atividade: row.atividade,
      forma_pgto: row.forma_pgto,
      tipo_cliente: row.tipo_cliente,
      funcionario: row.funcionario
    })));

  } catch (error) {
    console.error('Erro ao buscar relatório de diárias:', error);
    res.status(500).json({ erro: 'Erro ao buscar relatório de diárias' });
  }
});

// 5. RELATÓRIO DE RECEBIMENTOS TOTAIS
app.get('/api/relatorio/totais/:academiaid', async (req, res) => {
  try {
    const { academiaid } = req.params;
    const { datainicio, datafim } = req.query;

    let whereClause = 'WHERE id_academia = ?';
    const params = [academiaid];

    if (datainicio && datafim) {
      whereClause += ' AND DATE(data) >= DATE(?) AND DATE(data) <= DATE(?)';
      params.push(datainicio, datafim);
    }

    const query = `
      SELECT 
        DATE_FORMAT(data, '%Y-%m-%d') as data, hora, nome as cliente, valor, atividades as atividade, 
        forma_pgto, tipo_cliente, funcionario, 'MENSALIDADE' as origem
      FROM recebimentos_mensalidades
      ${whereClause}
      
      UNION ALL
      
      SELECT 
        DATE_FORMAT(data, '%Y-%m-%d') as data, hora, cliente, valor_total as valor, produtos as atividade, 
        forma_pgto, 'VENDA' as tipo_cliente, funcionario, 'VENDA' as origem
      FROM recebimentos_vendas
      ${whereClause}
      
      UNION ALL
      
      SELECT 
        DATE_FORMAT(data, '%Y-%m-%d') as data, hora, cliente, valor, 'AVALIAÇÃO FÍSICA' as atividade, 
        '' as forma_pgto, 'AVALIAÇÃO' as tipo_cliente, funcionario, 'AVALIAÇÃO' as origem
      FROM recebimentos_avaliacoes
      ${whereClause}
      
      UNION ALL
      
      SELECT 
        DATE_FORMAT(data, '%Y-%m-%d') as data, hora, cliente, valor, 'DIÁRIA' as atividade, 
        forma_pgto, 'DIÁRIA' as tipo_cliente, funcionario, 'DIÁRIA' as origem
      FROM recebimentos_diarias
      ${whereClause}
      
      ORDER BY data DESC, hora DESC
    `;

    const allParams = [...params, ...params, ...params, ...params];
    const [rows] = await pool.query(query, allParams);

    res.json(rows.map(row => ({
      data: row.data,
      hora: row.hora,
      cliente: row.cliente,
      valor: parseFloat(row.valor),
      atividade: row.atividade,
      forma_pgto: row.forma_pgto,
      tipo_cliente: row.tipo_cliente,
      funcionario: row.funcionario,
      origem: row.origem
    })));

  } catch (error) {
    console.error('Erro ao buscar relatório totais:', error);
    res.status(500).json({ erro: 'Erro ao buscar relatório de recebimentos totais' });
  }
});

// 6. RELATÓRIO DE FREQUÊNCIA
app.get('/api/relatorio/frequencia/:academiaid', async (req, res) => {
  try {
    const { academiaid } = req.params;
    const { datainicio, datafim } = req.query;

    let query = `
      SELECT 
        DATE_FORMAT(f.data, '%Y-%m-%d') as data,
        f.hora,
        f.cliente,
        f.tipo_acesso,
        f.motivo
      FROM frequencia f
      WHERE f.id_academia = ?
    `;

    const params = [academiaid];

    if (datainicio && datafim) {
      query += ' AND DATE(f.data) >= DATE(?) AND DATE(f.data) <= DATE(?)';
      params.push(datainicio, datafim);
    }

    query += ' ORDER BY f.data DESC, f.hora DESC';

    const [rows] = await pool.query(query, params);
    res.json(rows);

  } catch (error) {
    console.error('Erro ao buscar relatório de frequência:', error);
    res.status(500).json({ erro: 'Erro ao buscar relatório de frequência' });
  }
});

// ===== RELATÓRIOS CONSOLIDADOS (MÚLTIPLAS ACADEMIAS) =====

// 1. MENSALIDADES CONSOLIDADO
app.get('/api/relatorio/mensalidades/todas', async (req, res) => {
  try {
    const { ids, datainicio, datafim } = req.query;

    console.log('=== RELATÓRIO MENSALIDADES CONSOLIDADO ===');
    console.log('IDs:', ids);
    console.log('Período:', datainicio, 'até', datafim);

    if (!ids) {
      return res.status(400).json({ erro: 'IDs são obrigatórios' });
    }

    const academiaIds = ids.split(',').map(id => parseInt(id));

    let query = `
      SELECT 
        DATE_FORMAT(rm.data, '%Y-%m-%d') as data,
        rm.hora,
        rm.nome as cliente,
        rm.valor,
        rm.atividades as atividade,
        rm.forma_pgto,
        rm.tipo_cliente,
        rm.funcionario
      FROM recebimentos_mensalidades rm
      WHERE rm.id_academia IN (?)
    `;

    const params = [academiaIds];

    if (datainicio && datafim) {
      query += ' AND DATE(rm.data) >= DATE(?) AND DATE(rm.data) <= DATE(?)';
      params.push(datainicio, datafim);
    }

    query += ' ORDER BY rm.data DESC, rm.hora DESC';

    console.log('Query SQL:', query);
    console.log('Params:', params);

    const [rows] = await pool.query(query, params);
    console.log('Registros retornados:', rows.length);

    res.json(rows.map(row => ({
      data: row.data,
      hora: row.hora,
      cliente: row.cliente,
      valor: parseFloat(row.valor),
      atividade: row.atividade,
      forma_pgto: row.forma_pgto,
      tipo_cliente: row.tipo_cliente || 'RENOVAÇÃO',
      funcionario: row.funcionario
    })));

  } catch (error) {
    console.error('Erro ao buscar relatório de mensalidades consolidado:', error);
    res.status(500).json({ erro: 'Erro ao buscar relatório' });
  }
});

// 2. VENDAS CONSOLIDADO
app.get('/api/relatorio/vendas/todas', async (req, res) => {
  try {
    const { ids, datainicio, datafim } = req.query;

    if (!ids) {
      return res.status(400).json({ erro: 'IDs são obrigatórios' });
    }

    const academiaIds = ids.split(',').map(id => parseInt(id));

    let query = `
      SELECT 
        DATE_FORMAT(rv.data, '%Y-%m-%d') as data,
        rv.hora,
        rv.cliente,
        rv.valor_total as valor,
        rv.produtos as atividade,
        rv.forma_pgto,
        'VENDA' as tipo_cliente,
        rv.funcionario
      FROM recebimentos_vendas rv
      WHERE rv.id_academia IN (?)
    `;

    const params = [academiaIds];

    if (datainicio && datafim) {
      query += ' AND DATE(rv.data) >= DATE(?) AND DATE(rv.data) <= DATE(?)';
      params.push(datainicio, datafim);
    }

    query += ' ORDER BY rv.data DESC, rv.hora DESC';

    const [rows] = await pool.query(query, params);

    res.json(rows.map(row => ({
      data: row.data,
      hora: row.hora,
      cliente: row.cliente,
      valor: parseFloat(row.valor),
      atividade: row.atividade,
      forma_pgto: row.forma_pgto,
      tipo_cliente: row.tipo_cliente,
      funcionario: row.funcionario
    })));

  } catch (error) {
    console.error('Erro ao buscar relatório de vendas consolidado:', error);
    res.status(500).json({ erro: 'Erro ao buscar relatório' });
  }
});

// 3. AVALIAÇÕES CONSOLIDADO
app.get('/api/relatorio/avaliacoes/todas', async (req, res) => {
  try {
    const { ids, datainicio, datafim } = req.query;

    if (!ids) {
      return res.status(400).json({ erro: 'IDs são obrigatórios' });
    }

    const academiaIds = ids.split(',').map(id => parseInt(id));

    let query = `
      SELECT 
        DATE_FORMAT(ra.data, '%Y-%m-%d') as data,
        ra.hora,
        ra.cliente,
        ra.valor,
        'AVALIAÇÃO FÍSICA' as atividade,
        '' as forma_pgto,
        'AVALIAÇÃO' as tipo_cliente,
        ra.funcionario
      FROM recebimentos_avaliacoes ra
      WHERE ra.id_academia IN (?)
    `;

    const params = [academiaIds];

    if (datainicio && datafim) {
      query += ' AND DATE(ra.data) >= DATE(?) AND DATE(ra.data) <= DATE(?)';
      params.push(datainicio, datafim);
    }

    query += ' ORDER BY ra.data DESC, ra.hora DESC';

    const [rows] = await pool.query(query, params);

    res.json(rows.map(row => ({
      data: row.data,
      hora: row.hora,
      cliente: row.cliente,
      valor: parseFloat(row.valor),
      atividade: row.atividade,
      forma_pgto: row.forma_pgto,
      tipo_cliente: row.tipo_cliente,
      funcionario: row.funcionario
    })));

  } catch (error) {
    console.error('Erro ao buscar relatório de avaliações consolidado:', error);
    res.status(500).json({ erro: 'Erro ao buscar relatório' });
  }
});

// 4. DIÁRIAS CONSOLIDADO
app.get('/api/relatorio/diarias/todas', async (req, res) => {
  try {
    const { ids, datainicio, datafim } = req.query;

    if (!ids) {
      return res.status(400).json({ erro: 'IDs são obrigatórios' });
    }

    const academiaIds = ids.split(',').map(id => parseInt(id));

    let query = `
      SELECT 
        DATE_FORMAT(rd.data, '%Y-%m-%d') as data,
        rd.hora,
        rd.cliente,
        rd.valor,
        'DIÁRIA' as atividade,
        rd.forma_pgto,
        'DIÁRIA' as tipo_cliente,
        rd.funcionario
      FROM recebimentos_diarias rd
      WHERE rd.id_academia IN (?)
    `;

    const params = [academiaIds];

    if (datainicio && datafim) {
      query += ' AND DATE(rd.data) >= DATE(?) AND DATE(rd.data) <= DATE(?)';
      params.push(datainicio, datafim);
    }

    query += ' ORDER BY rd.data DESC, rd.hora DESC';

    const [rows] = await pool.query(query, params);

    res.json(rows.map(row => ({
      data: row.data,
      hora: row.hora,
      cliente: row.cliente,
      valor: parseFloat(row.valor),
      atividade: row.atividade,
      forma_pgto: row.forma_pgto,
      tipo_cliente: row.tipo_cliente,
      funcionario: row.funcionario
    })));

  } catch (error) {
    console.error('Erro ao buscar relatório de diárias consolidado:', error);
    res.status(500).json({ erro: 'Erro ao buscar relatório' });
  }
});

// 5. TOTAIS CONSOLIDADO
app.get('/api/relatorio/totais/todas', async (req, res) => {
  try {
    const { ids, datainicio, datafim } = req.query;

    if (!ids) {
      return res.status(400).json({ erro: 'IDs são obrigatórios' });
    }

    const academiaIds = ids.split(',').map(id => parseInt(id));

    let whereClause = 'WHERE id_academia IN (?)';
    const params = [academiaIds];

    if (datainicio && datafim) {
      whereClause += ' AND DATE(data) >= DATE(?) AND DATE(data) <= DATE(?)';
      params.push(datainicio, datafim);
    }

    const query = `
      SELECT 
        DATE_FORMAT(data, '%Y-%m-%d') as data, hora, nome as cliente, valor, atividades as atividade, 
        forma_pgto, tipo_cliente, funcionario, 'MENSALIDADE' as origem
      FROM recebimentos_mensalidades
      ${whereClause}
      
      UNION ALL
      
      SELECT 
        DATE_FORMAT(data, '%Y-%m-%d') as data, hora, cliente, valor_total as valor, produtos as atividade, 
        forma_pgto, 'VENDA' as tipo_cliente, funcionario, 'VENDA' as origem
      FROM recebimentos_vendas
      ${whereClause}
      
      UNION ALL
      
      SELECT 
        DATE_FORMAT(data, '%Y-%m-%d') as data, hora, cliente, valor, 'AVALIAÇÃO FÍSICA' as atividade, 
        '' as forma_pgto, 'AVALIAÇÃO' as tipo_cliente, funcionario, 'AVALIAÇÃO' as origem
      FROM recebimentos_avaliacoes
      ${whereClause}
      
      UNION ALL
      
      SELECT 
        DATE_FORMAT(data, '%Y-%m-%d') as data, hora, cliente, valor, 'DIÁRIA' as atividade, 
        forma_pgto, 'DIÁRIA' as tipo_cliente, funcionario, 'DIÁRIA' as origem
      FROM recebimentos_diarias
      ${whereClause}
      
      ORDER BY data DESC, hora DESC
    `;

    const allParams = [...params, ...params, ...params, ...params];
    const [rows] = await pool.query(query, allParams);

    res.json(rows.map(row => ({
      data: row.data,
      hora: row.hora,
      cliente: row.cliente,
      valor: parseFloat(row.valor),
      atividade: row.atividade,
      forma_pgto: row.forma_pgto,
      tipo_cliente: row.tipo_cliente,
      funcionario: row.funcionario,
      origem: row.origem
    })));

  } catch (error) {
    console.error('Erro ao buscar relatório totais consolidado:', error);
    res.status(500).json({ erro: 'Erro ao buscar relatório' });
  }
});

// 6. FREQUÊNCIA CONSOLIDADO
app.get('/api/relatorio/frequencia/todas', async (req, res) => {
  try {
    const { ids, datainicio, datafim } = req.query;

    if (!ids) {
      return res.status(400).json({ erro: 'IDs são obrigatórios' });
    }

    const academiaIds = ids.split(',').map(id => parseInt(id));

    let query = `
      SELECT 
        DATE_FORMAT(f.data, '%Y-%m-%d') as data,
        f.hora,
        f.cliente,
        f.tipo_acesso,
        f.motivo
      FROM frequencia f
      WHERE f.id_academia IN (?)
    `;

    const params = [academiaIds];

    if (datainicio && datafim) {
      query += ' AND DATE(f.data) >= DATE(?) AND DATE(f.data) <= DATE(?)';
      params.push(datainicio, datafim);
    }

    query += ' ORDER BY f.data DESC, f.hora DESC';

    const [rows] = await pool.query(query, params);
    res.json(rows);

  } catch (error) {
    console.error('Erro ao buscar relatório de frequência consolidado:', error);
    res.status(500).json({ erro: 'Erro ao buscar relatório' });
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
  console.log(` API disponível em http://localhost:${PORT}/api/test`);
});

// ===== TRATAMENTO DE ERROS =====
process.on('unhandledRejection', (error) => {
  console.error(' Erro não tratado:', error);
});