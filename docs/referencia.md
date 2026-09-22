# NetO11y — referência completa

Este documento responde perguntas sobre o app: o que ele faz, como faz, de onde tira cada número, quanto
custa, o que precisa estar configurado e onde estão os limites.

Documentos irmãos: [visao-geral.md](visao-geral.md) apresenta o app em linguagem simples;
[how-this-app-was-built.md](how-this-app-was-built.md) conta as decisões de engenharia para quem vai mexer no
código.

---

## Sumário

1. [O que é e as quatro regras](#1-o-que-é-e-as-quatro-regras)
2. [Como funciona por dentro](#2-como-funciona-por-dentro)
3. [O catálogo de consultas](#3-o-catálogo-de-consultas)
4. [Famílias de extensão](#4-famílias-de-extensão)
5. [Como o status é decidido](#5-como-o-status-é-decidido)
6. [Causas prováveis](#6-causas-prováveis)
7. [O caminho ponta a ponta](#7-o-caminho-ponta-a-ponta)
8. [Domínio da falha](#8-domínio-da-falha)
9. [As telas](#9-as-telas)
10. [Fontes de dados e permissões](#10-fontes-de-dados-e-permissões)
11. [Custo](#11-custo)
12. [Escala](#12-escala)
13. [Configuração](#13-configuração)
14. [Como o app é testado](#14-como-o-app-é-testado)
15. [Perguntas frequentes](#15-perguntas-frequentes)

---

## 1. O que é e as quatro regras

App do Dynatrace AppEngine que lê uma rede do jeito que quem opera precisa: **onde dói, o que está por trás
disso, e se chegou nas pessoas que usam os sistemas.**

Quatro regras explicam praticamente toda decisão de desenho:

| Regra | O que significa na prática |
|---|---|
| **Funciona em qualquer ambiente** | Uma extensão SNMP da Dynatrace basta. Tags de site, circuitos, NetFlow e agentes somam; nenhum é pré-requisito. O que falta é nomeado na tela com o que destravaria. |
| **Lê só formato documentado** | Smartscape, métricas das extensões, problemas e eventos da plataforma, syslog do ActiveGate, traps, NetFlow via OpenTelemetry Collector, fluxos do OneAgent. Nenhum texto de log de fabricante é interpretado. |
| **Não julga saúde, e não tem limiar** | Vermelho e amarelo vêm de um problema aberto pelo Dynatrace Intelligence. Utilização, CPU, erro, reinício e latência são medida. Os únicos números que o app aplica são do cliente: o SLA marcado no circuito e o limite de queda de demanda, editável em Settings. |
| **Nada que chegou desaparece** | Um alerta que não pôde ser ligado a um equipamento continua listado, com o motivo. |

---

## 2. Como funciona por dentro

```
Grail ──(catálogo de consultas)──▶ registros ──(buildRealModel)──▶ modelo ──▶ telas
                                                                     │
                                            causas, caminho, isolamento, achados
```

**Um único ponto de leitura.** Todas as consultas ficam em um arquivo (`data/queries.ts`), cada uma com sua
janela, seu limite de linhas e suas marcações. Nada consulta o Grail fora dali — é isso que torna o custo
mensurável e a suíte de testes possível.

**Três ondas de carregamento.** O Grail executa um número limitado de consultas por usuário ao mesmo tempo, e
disparar tudo de uma vez deixa as respostas úteis atrás das lentas. O app carrega em três ondas: **inventário**
→ **o que toda visão precisa** → **o resto**. A primeira tela aparece quando a onda 1 assenta, ou após alguns
segundos se o ambiente estiver lento, e vai se preenchendo.

**Dois portões evitam pagar por dado que não existe:**

- **Famílias** — uma leitura barata da série de métricas diz quais famílias de extensão o ambiente envia; só
  as consultas dessas famílias rodam. Ambiente sem extensão de rede não roda nenhuma.
- **Fontes ausentes** — logs, vizinhos, fluxos e fluxos de agente são sondados uma vez. A fonte que volta
  vazia fica marcada como ausente **naquele navegador por 12 horas** e não é lida de novo. Settings mostra o
  que foi encontrado vazio, quando, e um botão para checar de novo.

**Leitura incremental de logs.** Log é cobrado pelo volume varrido, e a parte da janela já lida não muda. O
navegador guarda o que leu e a próxima abertura pede só o que chegou depois, juntando as duas partes. Três
formatos são mesclados, cada um com sua regra: série por balde (o balde relido substitui o anterior), último
visto por chave, e os N mais novos (a parte nova manda a partir do corte).

Dois detalhes que custaram um bug cada: um balde vazio volta como `null`, **inclusive para contagem**, e o
modelo distingue `null` de `0`; e registros podem ser ingeridos alguns minutos depois do seu horário, então a
releitura começa dez minutos antes de onde a anterior terminou.

**Um único construtor de modelo.** `buildRealModel` transforma resultados em modelo, e a ordem importa:
equipamentos → sites → saúde → reinícios → interfaces, VLANs, syslog, traps, topologia, alcançabilidade,
circuitos → **alertas** → **vereditos**. Tudo o que as telas mostram é derivado daí, então duas visões nunca
discordam.

---

## 3. O catálogo de consultas

As leituras principais, com a janela de cada uma. Janelas curtas são deliberadas: o custo de uma consulta de
log é *janela × volume do bucket*, não o que casa com o filtro.

| Consulta | Janela | O que traz |
|---|---|---|
| `devices` | — | Nós Smartscape `EXT_NETWORK_DEVICE` (até 50.000) |
| `interfaces` | — | Nós `EXT_NETWORK_INTERFACE` (até 150.000, só abaixo do limite de detalhe) |
| `netEdges` | — | Arestas Smartscape entre equipamentos e interfaces |
| `families` | — | Quais famílias de extensão o ambiente envia (portão) |
| `ifTraffic`, `ifErrors` | — | Contadores por porta, por família |
| `ifSummary` | — | Resumo por equipamento, usado acima do limite de detalhe |
| `cpu`, `memory`, `uptime` | — | Saúde do equipamento, por família |
| `reboots` | 24 h | `sysUpTime` andando para trás |
| `icmp` | — | Latência e perda dos monitores de disponibilidade |
| `problems7d` | 7 d | Problemas do Dynatrace Intelligence, abertos e fechados |
| `deviceLogs` | 6 h | Contagem de syslog e traps por equipamento, baldes de 15 min |
| `deviceLogsRecent` | 3 h | As 600 linhas mais novas do ambiente |
| `deviceLogs24h(ip)` | 24 h | Sob demanda: a linha do tempo de um equipamento |
| `neighbors` | 20 min | Vizinhança reportada pelo autodiscovery |
| `lldp` | — | Vizinhos LLDP/CDP como série de métrica |
| `routing` | — | Sessões BGP e OSPF |
| `flowTs` | 70 min | Banda por exportador, baldes de 5 min |
| `flowNets` | 1 h | Conversas NetFlow por /24 e aplicação |
| `flowFanIn` | 1 h | Destinos alcançados por muitas origens distintas |
| `appPaths` | 1 h | Qualidade por workload × rede remota × porta |
| `appNet` | 8 h | Retransmissão e round trip a cada 10 min (incremental) |
| `appNetBy` | 7 h | O mesmo por workload: última hora contra as seis anteriores |
| `cloud`, `cloudTop` | 24 h | Clusters, provedores e destinos mais pesados |
| `sessionNets` | 24 h | Sessões por hora e por sub-rede de cliente |

Marcações que uma consulta pode carregar:

- **`complete`** — precisa trazer o estado todo. Se voltar no limite, o app avisa que está vendo só parte e
  **para de afirmar um total**. Consultas de top-N são limitadas de propósito e não levam a marcação.
- **`detail`** — dado por interface; só roda enquanto o parque está abaixo de **3.000 equipamentos**.
- **`incremental`** — consulta de log lida em partes pelo navegador.

---

## 4. Famílias de extensão

Toda extensão SNMP da geração atual reporta um conjunto comum de métricas, e as de fabricante acrescentam as
suas. Em vez de espalhar `if (vendor === ...)` pelo código, **um catálogo descreve cada família**: o prefixo
de métrica, as chaves de tráfego, erro, CPU, memória e uptime, e as dimensões com que ela nomeia equipamentos
e portas. As consultas são geradas a partir dele.

Famílias hoje: `network_device` (genérica), `cisco`, `juniper`, `paloalto`, `f5` e uma família antiga que
reporta só as suas próprias métricas e é unida por endereço.

O modelo lê as famílias **na ordem do catálogo e deixa a primeira que reporta uma medida ganhar**, então um
equipamento coberto por duas extensões nunca é contado duas vezes. **Suportar outra extensão é acrescentar
uma entrada.**

---

## 5. Como o status é decidido

**Só alerta pinta.** Um equipamento, porta, link ou site é vermelho ou amarelo porque o Dynatrace Intelligence
tem um problema aberto sobre ele. A categoria do problema define a cor: *slowdown* e *resource contention* são
amarelo, o resto — disponibilidade, erro, alerta customizado — é vermelho. Problema **mutado** é ignorado
exatamente como a plataforma o ignora.

**O app não tem limiar nenhum.** Não existe um número neste código decidindo o que é CPU alta, porta
saturada ou disponibilidade ruim. Quem guarda esses números é a plataforma: os **alert templates** de
Infrastructure & Operations e os alertas que o cliente já escreveu. Se o app tivesse os seus, eles
discordariam dos do cliente — e quem está de plantão deixaria de confiar nos dois.

As únicas duas exceções são números **do cliente**, não do app:

- O **SLA** marcado na tag do circuito, usado na página de WAN links.
- O **limite de queda de demanda** que decide quando uma hora conta como queda, editável em Settings e
  guardado no próprio tenant.

Uma porta cujos contadores passam da velocidade que ela mesma reporta é marcada como *inconsistente* — isso
é um fato sobre o dado, não um limiar.

**Quatro vereditos**: `Critical`, `Warning`, `Healthy`, `Not monitored`. O último é tão importante quanto os
outros — equipamento descoberto mas não consultado, site sem nada sendo medido, salto sem medição. O app
nunca chama de saudável aquilo que não mediu.

**Como o alerta acha seu equipamento**, em ordem: id do Smartscape, id de entidade clássica, a interface que o
alerta nomeia, o monitor que vigia o equipamento, e o nome. O que não casa com nada vira **alerta não
posicionado**, listado com o escopo que ele declara.

**Um site é o pior do que está nele** — com uma exceção deliberada: site cujo link primário caiu mas cujo
backup está carregando fica **degradado**, não fora. O circuito continua crítico; o site, não.

---

## 6. Causas prováveis

O app agrupa os alertas abertos em **causas**, cada uma com escopo, evidência e linha do tempo.

**O agrupamento** junta os alertas que compartilham origem — o mesmo monitor de operadora, o mesmo data
center, o mesmo equipamento — e separa em dois blocos: **causas compartilhadas** (mais de um site, ou de
natureza de operadora/data center) e **falhas isoladas**.

**Cada causa carrega:**

- **Escopo**: quantos links, sites e equipamentos, e quais regiões.
- **Impacto**: sites fora, sessões perdidas ou lentas por hora.
- **Evidência**, em cinco origens: link WAN, SNMP, syslog, trap e aplicação — cada uma com horário e nível.
- **Linha do tempo**: o instante em que cada elemento foi afetado, montada dos horários que a plataforma
  registrou.
- **Incidente**, quando o alerta traz o identificador.

**O que não vira causa** também aparece: os alertas fora do domínio de rede são contados à parte, como "N
alertas fora da rede", porque são exatamente eles que decidem a pergunta seguinte.

---

## 7. O caminho ponta a ponta

**Não é traceroute e não usa NetFlow.** O caminho não é *descoberto* salto a salto: ele é **composto** a
partir do inventário que a plataforma já tem.

Para um site com data center, os saltos são:

```
Acesso ──▶ Borda ──▶ Operadora ──▶ Data center ──▶ Segurança ──▶ Aplicação
```

| Salto | De onde sai | O que mede |
|---|---|---|
| **Acesso** | Equipamentos do site com papel switch, AP, WLC, compute | Alertas abertos, RTT ICMP, CPU, disponibilidade, utilização de uplink |
| **Borda** | Equipamentos do site com papel edge, firewall, balanceador | O mesmo, na camada de saída do site |
| **Operadora** | O circuito WAN do site — o monitor ICMP marcado com `circuit_id`, `carrier`, `sla_ms` | Latência contra SLA, perda, jitter, e se está no ar |
| **Data center** | Equipamentos core e edge **no hub do site** | O mesmo conjunto de medidas |
| **Segurança** | Firewalls e balanceadores no hub | O mesmo |
| **Aplicação** | Sessões de usuário ou requisições atribuídas ao site | p90 do tempo de resposta e se ainda há sessões |

Sites sem circuito tagueado ganham uma variante com **Internet** no lugar da operadora, montada das sessões
BGP.

**Por que assim, e não traceroute:** um traceroute dá o caminho L3 de uma sonda, num instante, e para no
primeiro equipamento que não responde — e não diz nada sobre se os equipamentos daquele caminho estão
alertando. O caminho do app é o **caminho de serviço**: as camadas que o tráfego de um usuário atravessa entre
o site e as aplicações, cada uma sustentada por equipamentos que estão realmente sendo monitorados.

**A primeira camada ruim é apontada como causa provável** — e uma camada cujas únicas razões são consequência
de uma falha acima dela nunca é apontada.

**Limites, ditos com clareza:** o app não mostra os saltos internos da operadora (o backbone dela é *um*
salto, medido ponta a ponta pelo monitor ICMP contra o SLA contratado) e não descobre um caminho L3 arbitrário
entre dois hosts. Se um site não tem equipamento de um papel, aquele salto não aparece.

---

## 8. Domínio da falha

A pergunta que fecha o raciocínio: **o que está degradado tem a ver com a rede?**

O app compara três coisas que já tem:

1. Quantos alertas de rede estão abertos.
2. Quantos alertas estão abertos **fora** do domínio de rede (aplicação, serviço, host, outros).
3. A demanda da última hora completa — sessões de usuário, ou requisições onde não há RUM — contra a
   **mediana da mesma hora nos últimos sete dias**.

Daí saem quatro leituras: **rede implicada** (alertas de rede pouco antes da degradação), **não é a rede**
(nada aberto na rede e o problema está fora), **nada a isolar**, e **sem visão** (o ambiente não reporta nem
sessões nem requisições).

Como a base é uma mediana, metade dos dias fica acima dela: **acima de 100% é o normal**, não um sinal. Por
isso a manchete só mostra o percentual quando ele significa alguma coisa — uma queda ou um pico — e diz
"usual" no meio da faixa.

---

## 9. As telas

Detalhadas em [visao-geral.md](visao-geral.md). Em uma linha cada:

| Tela | Responde |
|---|---|
| **Live map** | O que está acontecendo agora, agrupado em causas, com evidência e domínio da falha |
| **Sites** | Como está a rede por região, operadora e tipo de site |
| **Devices** | Qual equipamento importa, entre dezenas ou dezenas de milhares |
| **WAN links** | Cada circuito contra o SLA que o cliente contratou |
| **Traffic** | O que passa pela rede e com que qualidade |
| **Painel de detalhes** | Um site, equipamento ou circuito por dentro, sem trocar de tela |
| **Settings › Data** | O que chega, o que falta, qual o próximo passo e quanto custa |

**Estado na URL.** Página, seleção, filtros, fonte de dados e escala ficam na URL — qualquer visão é
compartilhável e recarrega como estava.

**Busca** com ⌘K, sobre equipamentos, sites e circuitos.

**Drill-down nativo:** cada tela abre o objeto correspondente em Logs, Infrastructure & Operations, Problems,
Synthetic e Notebooks, já filtrado.

---

## 10. Fontes de dados e permissões

As 18 fontes estão tabeladas em [visao-geral.md](visao-geral.md#de-onde-vêm-os-dados), com o que cada uma
destrava. Aqui ficam os escopos que o app pede:

| Escopo | Para quê |
|---|---|
| `storage:smartscape:read` | Equipamentos e interfaces descobertos pelas extensões |
| `storage:metrics:read` | Tráfego, erros, CPU, uptime e latência ICMP |
| `storage:logs:read` | Syslog e traps ligados a cada equipamento |
| `storage:events:read` | Fluxos do OneAgent (bucket `default_network_flows`) |
| `storage:user.sessions:read` | Sessões, para a leitura de impacto no usuário |
| `storage:buckets:read`, `storage:system:read` | O medidor de custo e a recomendação de bucket |
| `davis-copilot:conversations:execute` | O Assist |
| `state:app-states:read/write` | Preferências do app |

---

## 11. Custo

**O que não é cobrado por varredura:** métricas, Smartscape e os problemas e eventos da plataforma. É sobre
eles que o app constrói inventário, saúde, reinícios, disponibilidade e **todos os status** — de propósito.

**O que é cobrado por GiB varrido:** logs (syslog, traps, NetFlow) e eventos (fluxos do OneAgent) e sessões.

**A regra que orienta o desenho:** o custo de uma consulta de log é **janela × quanto o bucket guarda**, não o
quanto casa com o filtro. Daí duas consequências:

- **Pedir o que cabe na tela.** Uma consulta que para quando tem suas linhas é cobrada pelo que varreu até
  ali. O limite de linhas *é* o preço — pedir três vezes o que a tela mostra custava três vezes por nada.
- **Janela menor, conta menor.** Onde a fonte escreve em ciclo conhecido, a janela é um múltiplo pequeno do
  ciclo, não um número redondo.

**Mecanismos no app:** leitura incremental com cache no navegador, portão de famílias, fontes ausentes
desligadas por 12 h, limites por consulta, e nenhuma atualização automática — o app lê quando é aberto ou
quando se pede.

**O app se mede.** Cada resposta informa o que o Grail varreu, e Settings mostra o que a carga leu, o custo na
tarifa publicada, quais consultas leem mais e — como uma consulta de log lê todos os registros dos seus baldes
— **quanto menor seria a conta com os logs de rede em um bucket próprio**. Em ambiente movimentado essa única
mudança vale mais que tudo que o app economiza sozinho.

---

## 12. Escala

**Acima de 3.000 equipamentos** (`DETAIL_MAX_DEVICES`), o app para de ler todas as portas de todos os
equipamentos — que seriam centenas de milhares de linhas — e passa a trabalhar com **resumos por
equipamento**, buscando as portas de um equipamento quando alguém o abre.

O que o trabalho de escala expôs, e o que resolveu:

- Qualquer cálculo por site que varria todos os equipamentos era quadrático. Equipamentos, circuitos e
  caminhos são indexados por site uma vez por modelo.
- Agrupar copiando lista por item também é quadrático, e aparecia em cinco lugares.
- Desenhar um elemento por equipamento não sobrevive a vinte mil: os pontos silenciosos viraram um caminho
  por cor, e os problemáticos continuam individuais, na borda, onde dá para apontar.
- No mapa, sites que caem perto na tela viram uma marca com a contagem e um anel com as proporções de status;
  as rotas entre grupos viram uma rota só.

Depois disso, **vinte mil equipamentos desenham na taxa de atualização do monitor** e nenhuma interação
bloqueia a thread principal por mais que um quadro ou dois.

---

## 13. Configuração

**Mínimo para o app abrir:** uma extensão SNMP da Dynatrace rodando num grupo de ActiveGate, monitorando os
equipamentos. Só isso.

**O que cada acréscimo destrava** — a ordem recomendada é a que o próprio app calcula em Settings › Data, com
os números do ambiente:

1. **Consultar todo equipamento descoberto com a extensão dele** — sem isso, CPU, memória, portas,
   disponibilidade e alertas não chegam.
2. **Alert templates de rede** — sem alerta nenhum, o app não pinta nada, porque não inventa status.
3. **Tags de site** nas configurações de monitoramento — nome, região e mapa.
4. **Tags de circuito** no monitor ICMP (`circuit_id`, `carrier`, `sla_ms`) — a página de WAN links.
5. **Sub-redes por site** — liga tráfego e sessões ao site.
6. **Vizinhança LLDP/CDP** — as rotas no mapa.
7. **Syslog no ActiveGate** e **extensão de traps** — evidência de causa e eventos.
8. **OneAgent nos hosts das aplicações** — a qualidade do caminho.
9. **NetFlow pelo OpenTelemetry Collector** — quem fala com quem.
10. **Bucket próprio para os logs de rede** — custo.

---

## 14. Como o app é testado

Não existe teste unitário para "isso lê a rede corretamente". A suíte trabalha a partir de um **parque
gerado**: dezenas de sites, vários fabricantes, uma queda de operadora, uma porta oscilando, problemas mutados
e em manutenção, syslog, traps, fluxos e sessões — no formato exato dos registros que o Grail devolve. O
código de modelo do próprio app roda sobre isso.

| Suíte | O que verifica |
|---|---|
| `validate.mjs` | **70 verificações** de cenário: o cenário chega à tela, nada é julgado sem alerta, ambiente sem tag ainda produz sites, resumo e portas concordam, log lido em duas partes é igual ao lido inteiro, o mapa não perde site, nenhum componente chama hook depois de retorno antecipado |
| `example_check.mjs` | **163 verificações** de coerência sobre a rede de exemplo, nos dois tamanhos: toda referência aponta para algo que existe, contador igual à série desenhada ao lado, nada datado no futuro, equipamento escuro escuro em toda leitura |
| `live_check.mjs` | O mesmo catálogo contra um ambiente real, com invariantes que valem seja qual for o conteúdo |
| `scorecard.mjs` | O que o app consegue entregar naquele ambiente e o que falta |
| `perf.mjs` | Vinte mil equipamentos pelo modelo |
| `hooks_after_return.mjs` | Lê os fontes atrás do erro de ordem de hooks |

**Quatro lições estão embutidas na suíte**, cada uma depois do mesmo bug acontecer mais de uma vez:

1. *Verificação ancorada no relógio mente.* E as próprias fixtures carregam horários — deixadas um dia, saem
   de todas as janelas. A suíte reconstrói um conjunto velho antes de ler.
2. *Dois caminhos para o mesmo número precisam ser conferidos um contra o outro.*
3. *Verificação que filtra lista vazia passa sobre nada.* Cada grupo afirma primeiro que aquilo existe.
4. *Hook depois de retorno condicional quebra a página em tempo de execução*, e nem o compilador nem o build
   enxergam.

---

## 15. Perguntas frequentes

**Como vocês descobrem o caminho ponta a ponta? Traceroute?**
Não. O caminho é composto do inventário, não descoberto salto a salto — veja a
[seção 7](#7-o-caminho-ponta-a-ponta). Equipamentos são agrupados por **papel** e por **site**, e a relação
site → data center vem do circuito WAN (ou do hub do site). O resultado é o *caminho de serviço*: as camadas
que o tráfego atravessa, cada uma sustentada por equipamentos monitorados de verdade.

**Preciso de NetFlow em todo segmento do caminho?**
Não. NetFlow não participa do caminho — ele responde "quem fala com quem e quanto". O caminho é montado de
Smartscape, métricas de extensão, monitores ICMP e alertas. Com NetFlow só em alguns pontos, a página de
tráfego mostra o que aqueles exportadores veem e diz quantos são.

**Por que o app não define os próprios limiares de saúde?**
Porque dois lugares julgando a mesma rede discordam, e quem está de plantão perde a confiança nos dois. O
julgamento é do Dynatrace Intelligence; o app mostra a medida ao lado. Os limiares que ele tem servem para
descrever, não para mudar cor — e desde a versão 0.1.32 nem isso: o app não guarda limiar nenhum.

**Funciona com equipamento de fabricante X?**
Se existe extensão SNMP da Dynatrace para ele, sim. O app lê o conjunto comum que todas reportam e, quando a
família é conhecida, as chaves específicas dela. Acrescentar suporte é acrescentar uma entrada no catálogo de
famílias.

**E se eu não tiver tags de site?**
O app deduz, nesta ordem: localização que o equipamento informa, grupo de autodiscovery, rede de gerência.
Nunca inventa site a partir do nome do equipamento. Com tag, tudo fica melhor — e o app diz isso na tela.

**Por que a tela não atualiza sozinha?**
Porque log é cobrado por varredura e atualização automática multiplicaria a conta pelo tempo que a aba ficar
aberta. O app lê ao abrir e quando se pede, e mostra o horário da leitura.

**Posso escolher o período?**
Hoje não: cada leitura tem a janela que a pergunta dela exige (3 h de linhas de log, 6 h de contadores, 24 h
de disponibilidade, 7 d de alertas). Um seletor global de período multiplicaria o custo de toda consulta
cobrada — se for necessário, o caminho é permitir ampliar **consultas específicas**, não todas.

**O app escreve alguma coisa no ambiente?**
Não. Todas as leituras são `read`; a única escrita é a preferência do próprio app (`state:app-states:write`).

**O que acontece se uma consulta falhar?**
A página segue com o que tem e a barra mostra quantas fontes ficaram indisponíveis, com os nomes. O app nunca
apresenta uma tela vazia como se fosse "tudo certo".

**Quanto custa rodar?**
Depende do volume de log do ambiente, porque é ele que define o que uma consulta varre. Settings › Data mostra
a conta daquele ambiente, com os números dele, e quanto cairia com os logs de rede em bucket próprio.

**Dá para avaliar antes de enviar dados?**
Sim. Uma rede de exemplo vem embutida — cerca de 550 sites no Brasil e nos Estados Unidos, ou o mesmo grupo
com 20 mil equipamentos — e passa exatamente pelo mesmo modelo que um ambiente real. A tela identifica que é
exemplo o tempo todo.

---

*NetO11y · app do Dynatrace AppEngine.*
