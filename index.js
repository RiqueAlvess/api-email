import express from "express";
import { chromium } from "playwright";
import pino from "pino";
import { z } from "zod";

// ==================== CONFIGURATION FOR RENDER ====================

const logger = pino({ 
    level: process.env.LOG_LEVEL || "info",
    // Em produção não usar pino-pretty - logs estruturados são melhores
    ...(process.env.NODE_ENV !== 'production' && {
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true
            }
        }
    })
});

const app = express();
app.use(express.json({ limit: "1mb" }));

const CONFIG = {
    outlookUrl: "https://outlook.office365.com/",
    timeoutMs: process.env.NODE_ENV === 'production' ? 300000 : 120000, // 5min em produção
    navigationTimeout: 180000, // 3min para navegação
    port: process.env.PORT || 3000,
    maxRetries: 3,
    retryDelay: 5000,

    // Argumentos otimizados para Chromium no Render
    browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-features=VizDisplayCompositor',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-web-security',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
        '--memory-pressure-off',
        '--max_old_space_size=1024',
        '--disable-extensions',
        '--disable-plugins',
        '--disable-default-apps',
        '--no-default-browser-check',
        '--disable-sync'
    ]
};

// ==================== UTILITIES ====================

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryOperation(operation, maxRetries = CONFIG.maxRetries, delayMs = CONFIG.retryDelay) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            logger.warn(`Tentativa ${attempt}/${maxRetries} falhou: ${error.message}`);
            
            if (attempt < maxRetries) {
                logger.info(`Aguardando ${delayMs}ms antes da próxima tentativa...`);
                await delay(delayMs);
                delayMs *= 1.5; // Backoff exponencial
            }
        }
    }
    
    throw lastError;
}

function logMemoryUsage(context = "") {
    const usage = process.memoryUsage();
    logger.info({
        context,
        heapUsed: Math.round(usage.heapUsed / 1024 / 1024) + 'MB',
        heapTotal: Math.round(usage.heapTotal / 1024 / 1024) + 'MB',
        external: Math.round(usage.external / 1024 / 1024) + 'MB',
        rss: Math.round(usage.rss / 1024 / 1024) + 'MB'
    }, "Uso de memória");
}

// ==================== SCHEMA ====================

const EmailSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
    to: z.union([z.string().email(), z.array(z.string().email())]).transform(val => Array.isArray(val) ? val : [val]),
    cc: z.union([z.string().email(), z.array(z.string().email())]).transform(val => Array.isArray(val) ? val : [val]).optional(),
    subject: z.string().min(1),
    body: z.string().default(""),
    debug: z.boolean().default(false),
    priority: z.enum(['low', 'normal', 'high']).default('normal')
});

// ==================== MAIN FUNCTION (CHROMIUM OPTIMIZED) ====================

async function enviarEmail({ email, password, to, cc, subject, body, debug = false, priority = 'normal' }) {
    const logs = [];
    const startTime = Date.now();

    function log(message, level = 'info') {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${message}`;
        console.log(logMessage);
        if (debug) logs.push(logMessage);
        logger[level](message);
    }

    let navegador = null;
    let contexto = null;
    let pagina = null;

    try {
        log("🚀 Iniciando navegador Chromium no Render...", 'info');
        log(`Platform: ${process.platform}, Node: ${process.version}`, 'info');
        logMemoryUsage("Início");

        // Configuração otimizada para Chromium no Render
        navegador = await retryOperation(async () => {
            return await chromium.launch({
                headless: process.env.HEADLESS !== 'false',
                args: CONFIG.browserArgs,
                timeout: CONFIG.timeoutMs,
                slowMo: process.env.NODE_ENV === 'production' ? 100 : 0 // Slow motion em produção
            });
        });

        contexto = await navegador.newContext({
            userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport: { width: 1366, height: 768 },
            ignoreHTTPSErrors: true,
            permissions: [],
            // Configurações para economizar recursos
            reducedMotion: 'reduce',
            forcedColors: 'none',
            colorScheme: 'light'
        });

        pagina = await contexto.newPage();

        // Timeouts específicos para Render
        pagina.setDefaultTimeout(CONFIG.timeoutMs);
        pagina.setDefaultNavigationTimeout(CONFIG.navigationTimeout);

        // Bloquear recursos desnecessários mais agressivamente
        await pagina.route('**/*.{png,jpg,jpeg,gif,svg,ico,woff,woff2,mp4,mp3,pdf}', route => route.abort());
        await pagina.route('**/analytics/**', route => route.abort());
        await pagina.route('**/tracking/**', route => route.abort());
        await pagina.route('**/ads/**', route => route.abort());

        // Interceptar erros de console
        pagina.on('console', msg => {
            if (msg.type() === 'error') {
                log(`Console Error: ${msg.text()}`, 'warn');
            }
        });

        log("🔐 Fazendo login no Outlook...", 'info');
        logMemoryUsage("Antes do login");

        // LOGIN com retry automático
        await retryOperation(async () => {
            await pagina.goto(CONFIG.outlookUrl, {
                waitUntil: 'domcontentloaded',
                timeout: CONFIG.navigationTimeout
            });

            // Aguarda campo de email aparecer
            await pagina.waitForSelector("#i0116", { timeout: 90000 });
            await pagina.locator("#i0116").fill(email);
            await pagina.locator("#idSIButton9").click();

            // Aguarda campo de senha
            await pagina.waitForSelector("#i0118", { timeout: 90000 });
            await pagina.locator("#i0118").fill(password);
            await pagina.locator("#idSIButton9").click();
        });

        // Lida com "Manter conectado" com timeout
        try {
            await pagina.waitForSelector("#idSIButton9", { timeout: 15000 });
            await pagina.locator("#idSIButton9").click();
            log("Selecionou 'Manter conectado'", 'info');
        } catch {
            log("Prompt 'manter conectado' não apareceu ou timeout", 'info');
        }

        // Aguarda carregamento completo com mais tolerância
        try {
            await pagina.waitForLoadState('networkidle', { timeout: 60000 });
        } catch {
            log("Timeout em networkidle, continuando...", 'warn');
            await pagina.waitForLoadState('domcontentloaded');
        }

        await delay(8000); // Delay maior para Render
        log("✅ Login realizado com sucesso!", 'info');
        logMemoryUsage("Após login");

        // PROCURA E CLICA NO BOTÃO NOVO EMAIL
        log("📝 Procurando botão 'Novo email'...", 'info');

        const seletoresNovoEmail = [
            'button.splitPrimaryButton[aria-label="Novo email"]',
            'button.splitPrimaryButton[aria-label*="Novo"]',
            '[data-automation-type="RibbonSplitButton"][aria-label="Novo email"] button.splitPrimaryButton',
            '[data-automation-type="RibbonSplitButton"][aria-label*="Novo"] button.splitPrimaryButton',
            '.splitButtonContainer button.splitPrimaryButton',
            '[data-automationid="splitbuttonprimary"]',
            'button:has-text("Novo email")',
            'button:has-text("Novo")',
            '[aria-label="Novo email"]',
            '[aria-label*="Novo"]'
        ];

        let botaoClicado = false;

        // Tenta cada seletor com mais paciência
        for (const seletor of seletoresNovoEmail) {
            if (botaoClicado) break;

            try {
                log(`🔍 Tentando seletor: ${seletor}`, 'info');
                await pagina.waitForTimeout(2000);
                
                const botoes = pagina.locator(seletor);
                const quantidade = await botoes.count();
                log(`Encontrados: ${quantidade} elementos`, 'info');

                if (quantidade > 0) {
                    const indiceMax = Math.min(quantidade, 5);

                    for (let i = 0; i < indiceMax; i++) {
                        try {
                            const botao = botoes.nth(i);

                            // Verifica se é o botão primário correto
                            const isButtonPrimary = await botao.evaluate((el) => {
                                const hasNewEmailText = el.textContent && (
                                    el.textContent.includes('Novo email') || 
                                    el.textContent.includes('Novo') ||
                                    el.getAttribute('aria-label')?.includes('Novo')
                                );
                                const isPrimary = !el.getAttribute('aria-haspopup') || 
                                                el.classList.contains('splitPrimaryButton');
                                return hasNewEmailText && isPrimary;
                            });

                            if (!isButtonPrimary) {
                                log(`Elemento ${i + 1} não é o botão principal, pulando...`, 'info');
                                continue;
                            }

                            const isVisible = await botao.isVisible();
                            log(`Botão ${i + 1} visível: ${isVisible}`, 'info');

                            if (isVisible) {
                                await botao.scrollIntoViewIfNeeded();
                                await delay(3000); // Mais tempo no Render
                                await botao.focus();
                                await delay(1500);
                                
                                // Click com retry
                                await retryOperation(async () => {
                                    await botao.click({ timeout: 20000, force: true });
                                }, 3, 2000);
                                
                                botaoClicado = true;
                                log(`✅ Clicou no botão usando: ${seletor} (elemento ${i + 1})`, 'info');
                                break;
                            }
                        } catch (error) {
                            log(`⚠️ Erro no elemento ${i + 1}: ${error.message}`, 'warn');
                            continue;
                        }
                    }
                }
            } catch (error) {
                log(`❌ Erro com seletor ${seletor}: ${error.message}`, 'warn');
                continue;
            }
        }

        // JavaScript fallback aprimorado
        if (!botaoClicado) {
            log("🔧 Tentativa JavaScript específica...", 'info');
            botaoClicado = await pagina.evaluate(() => {
                // Busca mais agressiva
                const searchTerms = ['Novo email', 'Novo', 'New mail', 'Compose'];
                
                for (const term of searchTerms) {
                    // Busca por aria-label
                    const botaoPorLabel = document.querySelector(`button[aria-label*="${term}"]`);
                    if (botaoPorLabel && botaoPorLabel.offsetParent !== null) {
                        botaoPorLabel.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        botaoPorLabel.focus();
                        botaoPorLabel.click();
                        return true;
                    }

                    // Busca por texto
                    const elementos = document.querySelectorAll('button, [role="button"]');
                    for (let el of elementos) {
                        if (el.textContent && el.textContent.includes(term) && 
                            el.offsetParent !== null) {
                            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            el.focus();
                            el.click();
                            return true;
                        }
                    }
                }
                return false;
            });

            if (botaoClicado) {
                log("✅ Clicou usando JavaScript específico!", 'info');
                await delay(8000);
            }
        }

        if (!botaoClicado) {
            throw new Error("❌ Não foi possível clicar no botão 'Novo email' após todas as tentativas");
        }

        // Aguarda janela de composição com timeout maior
        log("⏳ Aguardando janela de composição...", 'info');
        await retryOperation(async () => {
            await pagina.waitForSelector('[aria-label="Para"]', { timeout: 45000 });
        });
        
        log("✅ Janela de composição aberta!", 'info');
        logMemoryUsage("Janela de composição");

        // PREENCHE OS CAMPOS com delays maiores
        log("📧 Preenchendo destinatários...", 'info');
        const campoPara = pagina.locator('[aria-label="Para"]').first();
        await campoPara.click();
        await delay(2000);
        await campoPara.fill(to.join("; "));
        await delay(3000);

        // CC se houver
        if (cc && cc.length > 0) {
            log("📋 Preenchendo cópia...", 'info');
            try {
                // Tenta mostrar campo CC se não visível
                const botaoCc = pagina.locator('[aria-label="Mostrar Cc"]').or(pagina.locator('button:has-text("Cc")'));
                if (await botaoCc.count() > 0) {
                    await botaoCc.first().click();
                    await delay(2000);
                }

                const campoCc = pagina.locator('[aria-label="Cc"]').first();
                await campoCc.click();
                await delay(2000);
                await campoCc.fill(cc.join("; "));
                await delay(3000);
            } catch (error) {
                log(`⚠️ Erro ao preencher CC: ${error.message}`, 'warn');
            }
        }

        // ASSUNTO
        log("📌 Preenchendo assunto...", 'info');
        const campoAssunto = pagina.locator('[aria-label="Assunto"]').first();
        await campoAssunto.click();
        await delay(2000);
        await campoAssunto.fill(subject);
        await delay(3000);

        // CORPO
        if (body) {
            log("✍️ Preenchendo corpo da mensagem...", 'info');
            const seletoresCorpo = [
                '[aria-label="Corpo da mensagem"]',
                '[aria-label*="Corpo"]',
                '[aria-label*="Message body"]',
                '[role="textbox"][aria-multiline="true"]',
                '.rps_1fb8 [role="textbox"]'
            ];

            let corpoPreenchido = false;
            for (const seletor of seletoresCorpo) {
                try {
                    const editor = pagina.locator(seletor).first();
                    if (await editor.count() > 0) {
                        await editor.click();
                        await delay(3000);
                        
                        // Limpa conteúdo existente
                        await pagina.keyboard.press('Control+a');
                        await delay(1000);

                        if (body.includes('<') && body.includes('>')) {
                            // HTML content
                            await pagina.evaluate((html, selector) => {
                                const editor = document.querySelector(selector);
                                if (editor) {
                                    editor.innerHTML = html;
                                }
                            }, body, seletor);
                        } else {
                            // Texto simples
                            await editor.fill(body);
                        }
                        
                        await delay(3000);
                        corpoPreenchido = true;
                        break;
                    }
                } catch (error) {
                    log(`Tentativa de preencher corpo com ${seletor} falhou: ${error.message}`, 'warn');
                    continue;
                }
            }

            if (!corpoPreenchido) {
                log("⚠️ Não foi possível preencher o corpo da mensagem", 'warn');
            }
        }

        log("📤 Enviando email...", 'info');
        logMemoryUsage("Antes de enviar");

        // ENVIO com mais tentativas
        const seletoresEnviar = [
            'button[aria-label="Enviar"]',
            'button:has-text("Enviar")',
            '[data-automation-id="Send"]',
            '[title="Enviar"]',
            'span:has-text("Enviar")',
            'button[type="submit"]',
            '.ms-Button--primary:has-text("Enviar")'
        ];

        let emailEnviado = false;

        await retryOperation(async () => {
            for (const seletor of seletoresEnviar) {
                try {
                    const botaoEnviar = pagina.locator(seletor);
                    const count = await botaoEnviar.count();
                    
                    if (count > 0) {
                        const botao = botaoEnviar.first();
                        await botao.scrollIntoViewIfNeeded();
                        await delay(2000);
                        await botao.click();
                        emailEnviado = true;
                        log(`✅ Email enviado usando seletor: ${seletor}`, 'info');
                        break;
                    }
                } catch (error) {
                    continue;
                }
            }

            // JavaScript fallback para enviar
            if (!emailEnviado) {
                log("🔧 Tentativa JavaScript para enviar...", 'info');
                const botaoEncontrado = await pagina.evaluate(() => {
                    const searchTerms = ['Enviar', 'Send'];
                    
                    for (const term of searchTerms) {
                        // Procura por aria-label
                        const botaoPorLabel = document.querySelector(`button[aria-label*="${term}"]`);
                        if (botaoPorLabel && botaoPorLabel.offsetParent !== null) {
                            botaoPorLabel.click();
                            return true;
                        }

                        // Procura por texto
                        const elementos = document.querySelectorAll('button, [role="button"]');
                        for (let el of elementos) {
                            if (el.textContent && el.textContent.trim() === term && 
                                el.offsetParent !== null) {
                                el.click();
                                return true;
                            }
                        }
                    }
                    return false;
                });

                if (botaoEncontrado) {
                    emailEnviado = true;
                    log("✅ Email enviado usando busca JavaScript!", 'info');
                }
            }

            if (!emailEnviado) {
                throw new Error("❌ Não foi possível encontrar o botão de enviar");
            }
        }, 3, 3000);

        // Aguarda confirmação com mais tempo
        await delay(12000);
        log("✅ Email enviado com sucesso!", 'info');
        logMemoryUsage("Email enviado");

        // RESUMO
        const processingTime = Date.now() - startTime;
        log("📊 RESUMO DO ENVIO:", 'info');
        log(`📧 Para: ${to.join(", ")}`, 'info');
        if (cc && cc.length > 0) log(`📋 CC: ${cc.join(", ")}`, 'info');
        log(`📌 Assunto: ${subject}`, 'info');
        log(`📝 Corpo: ${body.length} caracteres`, 'info');
        log(`🕒 Tempo de processamento: ${Math.round(processingTime / 1000)}s`, 'info');
        log(`⏰ Enviado em: ${new Date().toLocaleString('pt-BR')}`, 'info');

        return {
            success: true,
            to,
            cc,
            subject,
            sentAt: new Date().toISOString(),
            processingTimeMs: processingTime,
            logs: debug ? logs : undefined,
            memoryUsage: process.memoryUsage(),
            browser: 'chromium'
        };

    } catch (error) {
        const processingTime = Date.now() - startTime;
        log(`❌ Erro: ${error.message}`, 'error');
        
        // Log detalhado para debug
        logger.error({
            message: error.message,
            stack: error.stack,
            platform: process.platform,
            nodeVersion: process.version,
            memory: process.memoryUsage(),
            processingTime
        }, "Erro detalhado no envio");

        throw new Error(`Falha no envio do email: ${error.message}`);
    } finally {
        // Cleanup com mais cuidado
        try {
            if (pagina) {
                await pagina.close();
                log("📄 Página fechada", 'info');
            }
            if (contexto) {
                await contexto.close();
                log("🔒 Contexto fechado", 'info');
            }
            if (navegador) {
                await navegador.close();
                log("🔒 Navegador fechado", 'info');
            }
        } catch (closeError) {
            log(`⚠️ Erro ao fechar recursos: ${closeError.message}`, 'warn');
        }

        // Force garbage collection se disponível
        if (global.gc) {
            global.gc();
            log("🗑️ Garbage collection executado", 'info');
        }

        logMemoryUsage("Após cleanup");
    }
}

// ==================== ROUTES ====================

app.get("/", (req, res) => {
    res.json({
        service: "outlook-email-api",
        version: "2.1.0",
        status: "online",
        browser: "chromium",
        platform: process.platform,
        node: process.version,
        environment: process.env.NODE_ENV || "development",
        uptime: Math.round(process.uptime()),
        memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
        },
        endpoints: {
            health: "GET /health",
            ping: "GET /ping",
            sendEmail: "POST /send-email"
        }
    });
});

app.get("/health", (req, res) => {
    const usage = process.memoryUsage();
    res.json({
        status: "healthy",
        browser: "chromium",
        timestamp: new Date().toISOString(),
        uptime: Math.round(process.uptime()),
        memory: {
            heapUsed: Math.round(usage.heapUsed / 1024 / 1024) + 'MB',
            heapTotal: Math.round(usage.heapTotal / 1024 / 1024) + 'MB',
            external: Math.round(usage.external / 1024 / 1024) + 'MB',
            rss: Math.round(usage.rss / 1024 / 1024) + 'MB'
        },
        platform: process.platform,
        node: process.version,
        env: process.env.NODE_ENV
    });
});

app.post("/send-email", async (req, res) => {
    const requestId = Date.now().toString(36);
    const startTime = Date.now();

    logger.info({ requestId, body: { ...req.body, password: '***' } }, "Nova requisição de email");

    try {
        const parseResult = EmailSchema.safeParse(req.body);
        if (!parseResult.success) {
            return res.status(400).json({
                error: "dados_invalidos",
                message: "Dados da requisição inválidos",
                details: parseResult.error.flatten(),
                requestId
            });
        }

        const { email, password, to, cc, subject, body, debug, priority } = parseResult.data;

        logger.info({
            requestId,
            email: email.substring(0, 5) + '***',
            to,
            subject,
            priority,
            platform: process.platform,
            browser: 'chromium',
            memory: process.memoryUsage()
        }, "Iniciando envio de email");

        const result = await enviarEmail({
            email,
            password,
            to,
            cc,
            subject,
            body,
            debug,
            priority
        });

        const processingTime = Date.now() - startTime;
        const response = {
            status: "sucesso",
            message: "Email enviado com sucesso via Chromium!",
            requestId,
            data: {
                ...result,
                processingTimeMs: processingTime
            }
        };

        logger.info({
            requestId,
            to,
            subject,
            processingTime,
            browser: 'chromium',
            memoryUsage: result.memoryUsage
        }, "Email enviado com sucesso");

        res.json(response);

    } catch (error) {
        const processingTime = Date.now() - startTime;
        
        logger.error({
            requestId,
            error: error.message,
            stack: error.stack,
            processingTime,
            browser: 'chromium',
            memory: process.memoryUsage()
        }, "Erro no envio");

        res.status(500).json({
            error: "falha_envio",
            message: error.message,
            requestId,
            browser: "chromium",
            processingTimeMs: processingTime,
            platform: process.platform,
            timestamp: new Date().toISOString()
        });
    }
});

// Health check específico para Render
app.get("/ping", (req, res) => {
    res.status(200).json({ 
        status: "pong", 
        browser: "chromium",
        timestamp: new Date().toISOString(),
        uptime: Math.round(process.uptime())
    });
});

// Endpoint de métricas
app.get("/metrics", (req, res) => {
    const usage = process.memoryUsage();
    res.json({
        timestamp: new Date().toISOString(),
        browser: "chromium",
        uptime: process.uptime(),
        memory: {
            heapUsed: usage.heapUsed,
            heapTotal: usage.heapTotal,
            external: usage.external,
            rss: usage.rss
        },
        cpu: process.cpuUsage(),
        platform: process.platform,
        arch: process.arch,
        version: process.version
    });
});

// ==================== ERROR HANDLERS ====================

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: "endpoint_nao_encontrado",
        message: `Endpoint ${req.method} ${req.path} não encontrado`,
        browser: "chromium",
        timestamp: new Date().toISOString()
    });
});

// Global error handler
app.use((error, req, res, next) => {
    logger.error({
        error: error.message,
        stack: error.stack,
        url: req.url,
        method: req.method
    }, "Erro global");

    res.status(500).json({
        error: "erro_interno",
        message: "Erro interno do servidor",
        browser: "chromium",
        timestamp: new Date().toISOString()
    });
});

// ==================== START SERVER ====================

const server = app.listen(CONFIG.port, '0.0.0.0', () => {
    logger.info({
        port: CONFIG.port,
        platform: process.platform,
        node: process.version,
        env: process.env.NODE_ENV,
        browser: 'chromium',
        memory: process.memoryUsage()
    }, "🚀 API Outlook com Chromium rodando no Render!");

    console.log(`🚀 Servidor rodando na porta ${CONFIG.port}`);
    console.log(`📡 Health check: http://localhost:${CONFIG.port}/health`);
    console.log(`📧 Enviar email: POST http://localhost:${CONFIG.port}/send-email`);
    console.log(`🏥 Ping: http://localhost:${CONFIG.port}/ping`);
    console.log(`📊 Métricas: http://localhost:${CONFIG.port}/metrics`);
    console.log(`🌐 Browser: Chromium (otimizado para Render)`);
});

// Graceful shutdown otimizado para Render
function gracefulShutdown(signal) {
    logger.info(`${signal} recebido, iniciando shutdown gracioso...`);
    
    server.close(async () => {
        logger.info("Servidor HTTP fechado");
        
        // Force cleanup se necessário
        if (global.gc) {
            global.gc();
            logger.info("Garbage collection executado no shutdown");
        }
        
        logger.info("Shutdown gracioso completado");
        process.exit(0);
    });
    
    // Force exit após 30 segundos
    setTimeout(() => {
        logger.error("Timeout no shutdown, forçando saída");
        process.exit(1);
    }, 30000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.fatal({
        error: error.message,
        stack: error.stack
    }, 'Uncaught Exception');
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.fatal({
        reason,
        promise
    }, 'Unhandled Rejection');
});

export default app;
