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

// ===== DASHBOARD CONSOLIDADO =====
app.get('/api/academias/dashboard-consolidado', async (req, res) => {
  try {
    const { ids, datainicio, datafim } = req.query;

    console.log('=== DEBUG DASHBOARD CONSOLIDADO ===');
    console.log('IDs recebidos:', ids);

    if (!ids || !datainicio || !datafim) {
      return res.status(400).json({ erro: 'ids, datainicio e datafim são obrigatórios' });
    }

    const academiaIds = ids.split(',').map(id => parseInt(id));

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
      console.log('Tabela clientes_excluidos não existe');
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

    res.json({
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
      periodoFiltrado: { datainicio, datafim }
    });

  } catch (error) {
    console.error('❌ ERRO:', error);
    res.status(500).json({ erro: 'Erro ao buscar dados', detalhes: error.message });
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
      periodoFiltrado: { datainicio, datafim }
    });

  } catch (error) {
    console.error('Erro:', error);
    res.status(500).json({ erro: 'Erro ao buscar dados' });
  }
});

// ===== RELATÓRIOS CONSOLIDADOS =====

app.get('/api/relatorio/mensalidades/todas', async (req, res) => {
  try {
    const { ids, datainicio, datafim } = req.query;

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
        COALESCE(rm.atividades, '') as atividade,
        COALESCE(rm.forma_pgto, '') as forma_pgto,
        COALESCE(rm.tipo_cliente, 'RENOVAÇÃO') as tipo_cliente,
        COALESCE(rm.funcionario, '') as funcionario
      FROM recebimentos_mensalidades rm
      WHERE rm.id_academia IN (?)
    `;

    const params = [academiaIds];

    if (datainicio && datafim) {
      query += ' AND DATE(rm.data) >= DATE(?) AND DATE(rm.data) <= DATE(?)';
      params.push(datainicio, datafim);
    }

    query += ' ORDER BY rm.data DESC, rm.hora DESC';

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
    console.error('Erro:', error);
    res.status(500).json({ erro: 'Erro ao buscar relatório', detalhes: error.message });
  }
});

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
        'Cliente' as cliente,
        rv.valor_total as valor,
        COALESCE(rv.produtos, '') as atividade,
        COALESCE(rv.forma_pgto, '') as forma_pgto,
        'VENDA' as tipo_cliente,
        COALESCE(rv.funcionario, '') as funcionario
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
    console.error('Erro:', error);
    res.status(500).json({ erro: 'Erro ao buscar relatório', detalhes: error.message });
  }
});

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
        COALESCE(ra.funcionario, '') as funcionario
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
    console.error('Erro:', error);
    res.status(500).json({ erro: 'Erro ao buscar relatório', detalhes: error.message });
  }
});

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
        '' as forma_pgto,
        'DIÁRIA' as tipo_cliente,
        COALESCE(rd.funcionario, '') as funcionario
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
    console.error('Erro:', error);
    res.status(500).json({ erro: 'Erro ao buscar relatório', detalhes: error.message });
  }
});

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
        DATE_FORMAT(data, '%Y-%m-%d') as data, hora, nome as cliente, valor, 
        COALESCE(atividades, '') as atividade, 
        COALESCE(forma_pgto, '') as forma_pgto, 
        COALESCE(tipo_cliente, 'RENOVAÇÃO') as tipo_cliente, 
        COALESCE(funcionario, '') as funcionario, 
        'MENSALIDADE' as origem
      FROM recebimentos_mensalidades
      ${whereClause}
      
      UNION ALL
      
      SELECT 
        DATE_FORMAT(data, '%Y-%m-%d') as data, hora, 'Cliente' as cliente, valor_total as valor, 
        COALESCE(produtos, '') as atividade, 
        COALESCE(forma_pgto, '') as forma_pgto, 
        'VENDA' as tipo_cliente, 
        COALESCE(funcionario, '') as funcionario, 
        'VENDA' as origem
      FROM recebimentos_vendas
      ${whereClause}
      
      UNION ALL
      
      SELECT 
        DATE_FORMAT(data, '%Y-%m-%d') as data, hora, cliente, valor, 
        'AVALIAÇÃO FÍSICA' as atividade, 
        '' as forma_pgto, 
        'AVALIAÇÃO' as tipo_cliente, 
        COALESCE(funcionario, '') as funcionario, 
        'AVALIAÇÃO' as origem
      FROM recebimentos_avaliacoes
      ${whereClause}
      
      UNION ALL
      
      SELECT 
        DATE_FORMAT(data, '%Y-%m-%d') as data, hora, cliente, valor, 
        'DIÁRIA' as atividade, 
        '' as forma_pgto, 
        'DIÁRIA' as tipo_cliente, 
        COALESCE(funcionario, '') as funcionario, 
        'DIÁRIA' as origem
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
    console.error('Erro:', error);
    res.status(500).json({ erro: 'Erro ao buscar relatório', detalhes: error.message });
  }
});

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
        COALESCE(f.tipo_acesso, '') as tipo_acesso,
        COALESCE(f.motivo, '') as motivo
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
    console.error('Erro:', error);
    res.status(500).json({ erro: 'Erro ao buscar relatório', detalhes: error.message });
  }
});

// ===== RELATÓRIOS INDIVIDUAIS =====

app.get('/api/relatorio/mensalidades/:academiaid', async (req, res) => {
  try {
    const { academiaid } = req.params;
    const { datainicio, datafim } = req.query;

    let query = `
      SELECT 
        DATE_FORMAT(rm.data, '%Y-%m-%d') as data,
        rm.hora,
        rm.nome as cliente,
        rm.valor,
        COALESCE(rm.atividades, '') as atividade,
        COALESCE(rm.forma_pgto, '') as forma_pgto,
        COALESCE(rm.tipo_cliente, 'RENOVAÇÃO') as tipo_cliente,
        COALESCE(rm.funcionario, '') as funcionario
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
    console.error('Erro:', error);
    res.status(500).json({ erro: 'Erro ao buscar relatório', detalhes: error.message });
  }
});

app.get('/api/relatorio/vendas/:academiaid', async (req, res) => {
  try {
    const { academiaid } = req.params;
    const { datainicio, datafim } = req.query;

    let query = `
      SELECT 
        DATE_FORMAT(rv.data, '%Y-%m-%d') as data,
        rv.hora,
        'Cliente' as cliente,
        rv.valor_total as valor,
        COALESCE(rv.produtos, '') as atividade,
        COALESCE(rv.forma_pgto, '') as forma_pgto,
        'VENDA' as tipo_cliente,
        COALESCE(rv.funcionario, '') as funcionario
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
    console.error('Erro:', error);
    res.status(500).json({ erro: 'Erro ao buscar relatório', detalhes: error.message });
  }
});

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
        COALESCE(ra.funcionario, '') as funcionario
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
    console.error('Erro:', error);
    res.status(500).json({ erro: 'Erro ao buscar relatório', detalhes: error.message });
  }
});

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
        '' as forma_pgto,
        'DIÁRIA' as tipo_cliente,
        COALESCE(rd.funcionario, '') as funcionario
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
    console.error('Erro:', error);
    res.status(500).json({ erro: 'Erro ao buscar relatório', detalhes: error.message });
  }
});

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
        DATE_FORMAT(data, '%Y-%m-%d') as data, hora, nome as cliente, valor, 
        COALESCE(atividades, '') as atividade, 
        COALESCE(forma_pgto, '') as forma_pgto, 
        COALESCE(tipo_cliente, 'RENOVAÇÃO') as tipo_cliente, 
        COALESCE(funcionario, '') as funcionario, 
        'MENSALIDADE' as origem
      FROM recebimentos_mensalidades
      ${whereClause}
      
      UNION ALL
      
      SELECT 
        DATE_FORMAT(data, '%Y-%m-%d') as data, hora, 'Cliente' as cliente, valor_total as valor, 
        COALESCE(produtos, '') as atividade, 
        COALESCE(forma_pgto, '') as forma_pgto, 
        'VENDA' as tipo_cliente, 
        COALESCE(funcionario, '') as funcionario, 
        'VENDA' as origem
      FROM recebimentos_vendas
      ${whereClause}
      
      UNION ALL
      
      SELECT 
        DATE_FORMAT(data, '%Y-%m-%d') as data, hora, cliente, valor, 
        'AVALIAÇÃO FÍSICA' as atividade, 
        '' as forma_pgto, 
        'AVALIAÇÃO' as tipo_cliente, 
        COALESCE(funcionario, '') as funcionario, 
        'AVALIAÇÃO' as origem
      FROM recebimentos_avaliacoes
      ${whereClause}
      
      UNION ALL
      
      SELECT 
        DATE_FORMAT(data, '%Y-%m-%d') as data, hora, cliente, valor, 
        'DIÁRIA' as atividade, 
        '' as forma_pgto, 
        'DIÁRIA' as tipo_cliente, 
        COALESCE(funcionario, '') as funcionario, 
        'DIÁRIA' as origem
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
    console.error('Erro:', error);
    res.status(500).json({ erro: 'Erro ao buscar relatório', detalhes: error.message });
  }
});

app.get('/api/relatorio/frequencia/:academiaid', async (req, res) => {
  try {
    const { academiaid } = req.params;
    const { datainicio, datafim } = req.query;

    let query = `
      SELECT 
        DATE_FORMAT(f.data, '%Y-%m-%d') as data,
        f.hora,
        f.cliente,
        COALESCE(f.tipo_acesso, '') as tipo_acesso,
        COALESCE(f.motivo, '') as motivo
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
    console.error('Erro:', error);
    res.status(500).json({ erro: 'Erro ao buscar relatório', detalhes: error.message });
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
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`✅ API disponível em http://localhost:${PORT}/api/test`);
});

// ===== TRATAMENTO DE ERROS =====
process.on('unhandledRejection', (error) => {
  console.error('❌ Erro não tratado:', error);
});