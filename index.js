import express from "express";
import { firefox } from "playwright";
import pino from "pino";
import { z } from "zod";

// ==================== CONFIGURATION FOR RENDER ====================

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.use(express.json({ limit: "1mb" }));

const CONFIG = {
    outlookUrl: "https://outlook.office365.com/",
    timeoutMs: 120000, // 2 minutos para servidores do Render
    port: process.env.PORT || 3000, // Render define PORT automaticamente

    // Argumentos específicos para containers/Render
    browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-features=VizDisplayCompositor'
    ]
};

// ==================== SCHEMA ====================

const EmailSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
    to: z.union([z.string().email(), z.array(z.string().email())]).transform(val => Array.isArray(val) ? val : [val]),
    cc: z.union([z.string().email(), z.array(z.string().email())]).transform(val => Array.isArray(val) ? val : [val]).optional(),
    subject: z.string().min(1),
    body: z.string().default(""),
    debug: z.boolean().default(false)
});

// ==================== FUNÇÃO PRINCIPAL (OTIMIZADA PARA RENDER) ====================

async function enviarEmail({ email, password, to, cc, subject, body, debug = false }) {
    const logs = [];

    function log(message) {
        console.log(message);
        if (debug) logs.push(message);
        logger.info(message);
    }

    let navegador = null;

    try {
        log("🚀 Iniciando navegador no Render...");
        log(`Platform: ${process.platform}, Node: ${process.version}`);

        // Configuração otimizada para Render
        navegador = await firefox.launch({
            headless: true, // SEMPRE true no Render
            args: CONFIG.browserArgs,
            timeout: CONFIG.timeoutMs
        });

        const contexto = await navegador.newContext({
            // Configurações para economizar recursos
            userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:91.0) Gecko/20100101 Firefox/91.0"
        });

        const pagina = await contexto.newPage();

        // Timeouts maiores para servidores
        pagina.setDefaultTimeout(CONFIG.timeoutMs);
        pagina.setDefaultNavigationTimeout(CONFIG.timeoutMs);

        // Bloquear recursos desnecessários para economizar banda
        await pagina.route('**/*.{png,jpg,jpeg,gif,svg,ico,woff,woff2}', route => route.abort());

        log("🔐 Fazendo login no Outlook...");

        // LOGIN com timeouts maiores
        await pagina.goto(CONFIG.outlookUrl, {
            waitUntil: 'domcontentloaded',
            timeout: CONFIG.timeoutMs
        });

        await pagina.waitForSelector("#i0116", { timeout: 60000 });
        await pagina.locator("#i0116").fill(email);
        await pagina.locator("#idSIButton9").click();

        await pagina.waitForSelector("#i0118", { timeout: 60000 });
        await pagina.locator("#i0118").fill(password);
        await pagina.locator("#idSIButton9").click();

        // Clica em "Sim" para manter logado
        try {
            await pagina.waitForSelector("#idSIButton9", { timeout: 10000 });
            await pagina.locator("#idSIButton9").click();
        } catch {
            log("Prompt 'manter logado' não apareceu");
        }

        // Aguarda carregar completamente com timeout maior
        await pagina.waitForLoadState('networkidle', { timeout: CONFIG.timeoutMs });
        await pagina.waitForTimeout(5000);

        log("✅ Login realizado com sucesso!");
        log("📝 Procurando botão 'Novo email'...");

        // SELETORES (mesmo do código original)
        const seletoresNovoEmail = [
            'button.splitPrimaryButton[aria-label="Novo email"]',
            '[data-automation-type="RibbonSplitButton"][aria-label="Novo email"] button.splitPrimaryButton',
            '.splitButtonContainer-219 button.splitPrimaryButton',
            'button.splitPrimaryButton.root-193',
            '[data-automationid="splitbuttonprimary"]',
            'button:has-text("Novo email")',
            '[aria-label="Novo email"]'
        ];

        let botaoClicado = false;

        // Tenta cada seletor
        for (const seletor of seletoresNovoEmail) {
            try {
                log(`🔍 Tentando seletor: ${seletor}`);
                const botoes = pagina.locator(seletor);
                const quantidade = await botoes.count();
                log(`Encontrados: ${quantidade} elementos`);

                if (quantidade > 0) {
                    const indiceMax = seletor.includes('data-automationid') ? 1 : Math.min(quantidade, 3);

                    for (let i = 0; i < indiceMax; i++) {
                        try {
                            const botao = botoes.nth(i);

                            const isButtonPrimary = await botao.evaluate((el) => {
                                return !el.getAttribute('aria-haspopup') ||
                                    el.classList.contains('splitPrimaryButton') ||
                                    el.textContent.includes('Novo email');
                            });

                            if (!isButtonPrimary && seletor.includes('data-automationid')) {
                                log(`Elemento ${i + 1} é dropdown, pulando...`);
                                continue;
                            }

                            const isVisible = await botao.isVisible();
                            log(`Botão ${i + 1} visível: ${isVisible}`);

                            if (isVisible) {
                                await botao.scrollIntoViewIfNeeded();
                                await pagina.waitForTimeout(2000); // Mais tempo no Render
                                await botao.focus();
                                await pagina.waitForTimeout(1000);
                                await botao.click({ timeout: 15000, force: true });
                                botaoClicado = true;
                                log(`✅ Clicou no botão usando: ${seletor} (elemento ${i + 1})`);
                                break;
                            }
                        } catch (error) {
                            log(`⚠️ Erro no elemento ${i + 1}: ${error.message}`);
                            continue;
                        }
                    }
                }
                if (botaoClicado) break;
            } catch (error) {
                log(`❌ Erro com seletor ${seletor}: ${error.message}`);
                continue;
            }
        }

        // JavaScript fallback
        if (!botaoClicado) {
            log("🔧 Tentativa JavaScript específica...");
            botaoClicado = await pagina.evaluate(() => {
                const botaoPrimario = document.querySelector('button.splitPrimaryButton[aria-label="Novo email"]');
                if (botaoPrimario && botaoPrimario.offsetParent !== null) {
                    botaoPrimario.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    botaoPrimario.focus();
                    botaoPrimario.click();
                    return true;
                }

                const botoes = document.querySelectorAll('button');
                for (let botao of botoes) {
                    if (botao.getAttribute('aria-label') === 'Novo email' && botao.classList.contains('splitPrimaryButton')) {
                        botao.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        botao.focus();
                        botao.click();
                        return true;
                    }
                }

                const container = document.querySelector('[data-automation-type="RibbonSplitButton"][aria-label="Novo email"]');
                if (container) {
                    const botaoInterno = container.querySelector('button.splitPrimaryButton');
                    if (botaoInterno) {
                        container.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        botaoInterno.focus();
                        botaoInterno.click();
                        return true;
                    }
                }
                return false;
            });

            if (botaoClicado) {
                log("✅ Clicou usando JavaScript específico!");
                await pagina.waitForTimeout(5000);
            }
        }

        if (!botaoClicado) {
            throw new Error("❌ Não foi possível clicar no botão 'Novo email'");
        }

        // Aguarda janela de composição com timeout maior
        await pagina.waitForSelector('[aria-label="Para"]', { timeout: 30000 });
        log("✅ Janela de composição aberta!");

        // PREENCHE OS CAMPOS com mais tempo entre ações
        log("📧 Preenchendo destinatários...");
        const campoPara = pagina.locator('[aria-label="Para"]');
        await campoPara.click();
        await campoPara.fill(to.join("; "));
        await pagina.waitForTimeout(2000);

        // CC se houver
        if (cc && cc.length > 0) {
            log("📋 Preenchendo cópia...");
            try {
                const campoCc = pagina.locator('[aria-label="Cc"]');
                await campoCc.click();
                await campoCc.fill(cc.join("; "));
                await pagina.waitForTimeout(2000);
            } catch (error) {
                log("⚠️ Campo CC não encontrado ou não visível");
            }
        }

        // ASSUNTO
        log("📌 Preenchendo assunto...");
        const campoAssunto = pagina.locator('[aria-label="Assunto"]');
        await campoAssunto.click();
        await campoAssunto.fill(subject);
        await pagina.waitForTimeout(2000);

        // CORPO
        if (body) {
            log("✍️ Preenchendo corpo da mensagem...");
            const editorCorpo = pagina.locator('[aria-label="Corpo da mensagem"]');
            await editorCorpo.click();
            await pagina.waitForTimeout(2000);
            await pagina.keyboard.press('Control+a');

            if (body.includes('<')) {
                await pagina.evaluate((html) => {
                    const editor = document.querySelector('[aria-label="Corpo da mensagem"]');
                    if (editor) {
                        editor.innerHTML = html;
                    }
                }, body);
            } else {
                await editorCorpo.fill(body);
            }
            await pagina.waitForTimeout(2000);
        }

        log("📤 Enviando email...");

        // ENVIA com timeouts maiores
        const seletoresEnviar = [
            'span.fui-Button__icon:has-text("Enviar")',
            'span:has(.fui-Button__icon):has-text("Enviar")',
            'button:has-text("Enviar")',
            '[aria-label="Enviar"]',
            '[data-automation-id="Send"]',
            '[title="Enviar"]'
        ];

        let emailEnviado = false;

        for (const seletor of seletoresEnviar) {
            try {
                const botaoEnviar = pagina.locator(seletor);
                if (await botaoEnviar.count() > 0) {
                    await botaoEnviar.first().click();
                    emailEnviado = true;
                    log(`✅ Email enviado usando seletor: ${seletor}`);
                    break;
                }
            } catch (error) {
                continue;
            }
        }

        // JavaScript fallback para enviar
        if (!emailEnviado) {
            try {
                log("🔧 Tentativa JavaScript para enviar...");
                const botaoEncontrado = await pagina.evaluate(() => {
                    const spans = document.querySelectorAll('span.fui-Button__icon');
                    for (let span of spans) {
                        if (span.textContent && span.textContent.includes('Enviar')) {
                            span.click();
                            return true;
                        }
                    }

                    const todosElementos = document.querySelectorAll('*');
                    for (let elemento of todosElementos) {
                        if (elemento.textContent === 'Enviar' &&
                            (elemento.tagName === 'BUTTON' || elemento.onclick || elemento.getAttribute('role') === 'button')) {
                            elemento.click();
                            return true;
                        }
                    }
                    return false;
                });

                if (botaoEncontrado) {
                    emailEnviado = true;
                    log("✅ Email enviado usando busca JavaScript!");
                }
            } catch (error) {
                log(`⚠️ Erro na busca JavaScript: ${error.message}`);
            }
        }

        if (!emailEnviado) {
            throw new Error("❌ Não foi possível encontrar o botão de enviar");
        }

        // Aguarda confirmação com mais tempo
        await pagina.waitForTimeout(8000);
        log("✅ Email enviado com sucesso!");

        log("📊 RESUMO DO ENVIO:");
        log(`📧 Para: ${to.join(", ")}`);
        if (cc) log(`📋 CC: ${cc.join(", ")}`);
        log(`📌 Assunto: ${subject}`);
        log(`📝 Corpo: ${body.length} caracteres`);
        log(`⏰ Enviado em: ${new Date().toLocaleString('pt-BR')}`);

        return {
            success: true,
            to,
            cc,
            subject,
            sentAt: new Date().toISOString(),
            logs: debug ? logs : undefined
        };

    } catch (error) {
        log(`❌ Erro: ${error.message}`);
        // Log mais detalhado para debug no Render
        logger.error({
            message: error.message,
            stack: error.stack,
            platform: process.platform,
            nodeVersion: process.version,
            memory: process.memoryUsage()
        }, "Erro detalhado");
        throw error;
    } finally {
        if (navegador) {
            try {
                await navegador.close();
                log("🔒 Navegador fechado");
            } catch (closeError) {
                log(`⚠️ Erro ao fechar navegador: ${closeError.message}`);
            }
        }
    }
}

// ==================== ROUTES ====================

app.get("/", (req, res) => {
    res.json({
        service: "outlook-email-api",
        version: "1.0.0",
        status: "online",
        platform: process.platform,
        node: process.version,
        environment: process.env.NODE_ENV || "development",
        endpoints: {
            health: "GET /health",
            sendEmail: "POST /send-email"
        }
    });
});

app.get("/health", (req, res) => {
    res.json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        platform: process.platform
    });
});

app.post("/send-email", async (req, res) => {
    const startTime = Date.now();

    try {
        const parseResult = EmailSchema.safeParse(req.body);
        if (!parseResult.success) {
            return res.status(400).json({
                error: "dados_invalidos",
                message: "Dados da requisição inválidos",
                details: parseResult.error.flatten()
            });
        }

        const { email, password, to, cc, subject, body, debug } = parseResult.data;

        logger.info({
            email,
            to,
            subject,
            platform: process.platform,
            memory: process.memoryUsage()
        }, "Iniciando envio de email");

        const result = await enviarEmail({
            email,
            password,
            to,
            cc,
            subject,
            body,
            debug
        });

        const response = {
            status: "sucesso",
            message: "Email enviado com sucesso!",
            data: {
                ...result,
                processingTimeMs: Date.now() - startTime
            }
        };

        logger.info({
            to,
            subject,
            processingTime: Date.now() - startTime
        }, "Email enviado com sucesso");

        res.json(response);

    } catch (error) {
        logger.error({
            error: error.message,
            processingTime: Date.now() - startTime,
            memory: process.memoryUsage()
        }, "Erro no envio");

        res.status(500).json({
            error: "falha_envio",
            message: error.message,
            processingTimeMs: Date.now() - startTime,
            platform: process.platform
        });
    }
});

// Health check específico para Render
app.get("/ping", (req, res) => {
    res.status(200).send("pong");
});

// ==================== START SERVER ====================

const server = app.listen(CONFIG.port, '0.0.0.0', () => {
    logger.info({
        port: CONFIG.port,
        platform: process.platform,
        node: process.version,
        env: process.env.NODE_ENV
    }, "🚀 API Outlook rodando no Render!");

    console.log(`🚀 Servidor rodando na porta ${CONFIG.port}`);
    console.log(`📡 Health check: http://localhost:${CONFIG.port}/health`);
    console.log(`📧 Enviar email: POST http://localhost:${CONFIG.port}/send-email`);
    console.log(`🏥 Ping: http://localhost:${CONFIG.port}/ping`);
});

// Graceful shutdown para Render
process.on("SIGTERM", () => {
    logger.info("SIGTERM recebido, fechando servidor...");
    server.close(() => {
        logger.info("Servidor fechado graciosamente");
        process.exit(0);
    });
});

process.on("SIGINT", () => {
    logger.info("SIGINT recebido, fechando servidor...");
    server.close(() => {
        logger.info("Servidor fechado graciosamente");
        process.exit(0);
    });
});

export default app;