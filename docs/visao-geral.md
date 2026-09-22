# NetO11y — visão geral

Um app do Dynatrace que mostra a rede do jeito que quem opera precisa ler: **onde dói, o que está por trás
disso, e se o problema chegou nas pessoas que usam os sistemas.**

> Este documento explica o app para quem vai usá-lo ou apresentá-lo. Para as decisões de engenharia por trás
> dele, veja [how-this-app-was-built.md](how-this-app-was-built.md).

---

## A ideia, em quatro frases

Um ambiente Dynatrace já guarda muita coisa sobre a rede: os equipamentos descobertos, o que eles respondem
quando são consultados, os alertas abertos, as mensagens que eles próprios enviam. Só que esses dados ficam
espalhados em telas diferentes, cada uma pensada para outra pergunta.

O NetO11y junta tudo isso em um modelo só e responde três perguntas na ordem em que elas aparecem numa sala de
operação. Nada é inventado: quando falta um dado, o app diz o que falta e o que aquilo destravaria, em vez de
mostrar uma tela vazia.

| | |
|---|---|
| **1. O que quebrou?** | Os alertas agrupados em causas prováveis, com tudo que está atrás de cada uma. |
| **2. Onde dói?** | Quais sites, links e equipamentos estão no caminho, e desde quando. |
| **3. Chegou no usuário?** | As pessoas continuaram usando os sistemas enquanto a rede falhava? |

## As quatro regras do app

1. **Funciona em qualquer ambiente.** Basta ter uma extensão SNMP da Dynatrace monitorando a rede. Tags de
   site, circuitos, exportadores de fluxo e agentes *somam* — nunca são pré-requisito.
2. **Lê só formato documentado.** Nenhum texto de log de fabricante é interpretado. Assim nada quebra quando
   um equipamento muda a redação de uma mensagem.
3. **Não inventa saúde.** Vermelho e amarelo vêm de um problema aberto pelo Dynatrace Intelligence.
   Utilização, erro, reinício e latência aparecem como *medida*, não como julgamento.
4. **Nada que chegou desaparece.** Um alerta que o app não consegue ligar a nenhum equipamento continua na
   lista, com o motivo de não ter sido posicionado.

---

## As telas

### Live map — a tela inicial

**Para que serve:** entender, em dez segundos, se algo grande está acontecendo e o que é.

**O que você vê:** o mapa da rede, com as **causas prováveis** listadas à esquerda e o raciocínio da causa
escolhida à direita. Três abas: **Causas**, **Sites** (uma árvore por região) e **Mudanças** (o que mexeu nas
últimas 24 horas: reinícios, equipamentos que pararam de responder, alertas que abriram ou fecharam, circuitos
que caíram). Cada causa mostra quantos links, sites, equipamentos e sessões estão atrás dela, as evidências
que a sustentam e a hora em que começou.

> **O diferencial.** Uma queda de operadora vira *uma* causa com 14 sites — não 14 alertas soltos para alguém
> juntar na mão. E logo abaixo o app diz se o que está ruim tem ou não cara de rede, comparando os alertas de
> rede com os que estão fora dela.

### Sites

**Para que serve:** ver a saúde da rede por região e por operadora, sem abrir site por site.

**O que você vê:** cada site é um quadradinho colorido pelo seu status, agrupado por região. Filtros de
operadora e de tipo — loja, escritório, centro de distribuição, data center. Dá para alternar entre o visual e
uma tabela comum.

> **O diferencial.** O app respeita a organização do cliente: o site vem da tag que ele já usa. Sem tag, o app
> deduz pela localização que o equipamento informa, pelo grupo de descoberta ou pela rede de gerência — mas
> nunca inventa um site a partir do nome do equipamento.

### Devices — os equipamentos

**Para que serve:** achar rápido o equipamento que importa, entre dezenas ou dezenas de milhares.

**O que você vê:** uma bolha por função (roteador de borda, switch, firewall, access point…), do tamanho da
quantidade de equipamentos que ela tem. Em volta de cada bolha, um **anel** mostra a proporção de crítico,
alerta e saudável — e clicar numa fatia do anel já filtra a página. Ao lado, os instrumentos do equipamento
selecionado: CPU, disponibilidade, interfaces no ar, erros de syslog, traps.

> **O diferencial.** Com 20 mil equipamentos a tela continua fluida, porque os pontos saudáveis são desenhados
> em bloco e só os problemáticos viram elementos individuais — na borda da bolha, onde dá para clicar.

### WAN links — os circuitos

**Para que serve:** ver cada link contratado contra o que a operadora prometeu.

**O que você vê:** os circuitos agrupados por operadora, com latência, perda e jitter nas últimas 24 horas,
comparados ao SLA. Se ninguém tagueou os circuitos ainda, a página *não* fica vazia: mostra a alcançabilidade
de cada site pelos testes de ping e explica exatamente o que tagear para virar circuito.

> **O diferencial.** O SLA exibido é o que o próprio cliente marcou no monitor. É o único número do app que
> julga alguma coisa — e é o número dele, não um limite que inventamos.

### Traffic — o tráfego

**Para que serve:** responder "o que está passando pela rede e como está passando".

**O que você vê:** a banda da última hora por exportador; **quem fala com quem** entre os sites e a Internet;
as principais conversas, com o volume de ida e de volta; e a **qualidade do caminho** — retransmissão de TCP e
tempo de resposta por aplicação.

> **O diferencial.** Duas fontes respondendo perguntas diferentes lado a lado: o NetFlow (que vem do roteador)
> diz *quanto e para onde*; o OneAgent (que vem do servidor) diz *se está bom*. Com só uma das duas a página
> continua útil e avisa qual metade está faltando.

### Painel de detalhes — site, equipamento ou circuito

**Para que serve:** investigar sem trocar de tela.

**O que você vê, para um site:** o **caminho ponta a ponta** — acesso → borda → operadora → data center →
segurança → aplicação — com a medida de cada salto e o motivo do veredito; a faixa de 24 horas mostrando
quando cada equipamento respondeu; os links contra o SLA; o tráfego; e o domínio da falha.

> **O diferencial.** Cada salto mostra o número *com a unidade*, e um salto sem medição fica cinza — nunca
> verde. "Não medido" não é sinônimo de "está bem".

### Settings › Data — o que o app lê

**Para que serve:** saber o que já chega, o que falta e quanto isso custa.

**O que você vê:** o que cada página precisa e o que já está chegando; o **próximo passo** de maior valor para
aquele ambiente, com os números dele; como enviar cada tipo de dado; e um medidor de custo com quanto a última
carga leu e quanto isso custa.

> **O diferencial.** O app mede a si mesmo e recomenda, com os números do próprio cliente, quanto a conta
> cairia se os logs de rede fossem para um bucket separado — costuma valer mais do que tudo que o app economiza
> sozinho.

---

## De onde vêm os dados

São 18 fontes. **Só a primeira é obrigatória** — as outras 17 somam, e o que estiver faltando aparece na tela
junto com o que destravaria.

### Inventário — o que existe e onde está

| Fonte | O que é, em palavras simples | O que destrava no app |
|---|---|---|
| Equipamentos | Extensões SNMP rodando num ActiveGate: elas perguntam aos equipamentos sobre eles mesmos e registram o que existe na rede | Toda página do app: roteadores, switches, firewalls, balanceadores e access points, com sua saúde |
| Interfaces | As portas de cada equipamento, coletadas pela mesma extensão | Lista de portas com status, velocidade e identificação de qual é o uplink |
| Sites | Tags que o cliente coloca na configuração de monitoramento dizendo a que site cada equipamento pertence | Nome e região do site, posição no mapa e de qual data center ele depende |

### Saúde e carga — como cada equipamento está

| Fonte | O que é, em palavras simples | O que destrava no app |
|---|---|---|
| Tráfego de porta | Os contadores que cada porta mantém de quanto passou por ela | Utilização, saturação, erros, descartes e VLANs |
| CPU e memória | Métricas que a extensão coleta do equipamento | Instrumentos do equipamento — como medida, ao lado dos alertas |
| Disponibilidade | O tempo que o equipamento diz estar ligado, consultado a cada minuto | A faixa de 24 horas de quando ele respondeu, e a detecção de reinício |

### Alcançabilidade e WAN — se o site responde e como o link se comporta

| Fonte | O que é, em palavras simples | O que destrava no app |
|---|---|---|
| ICMP (ping) | Monitores de disponibilidade que pingam os equipamentos — inclusive os que a Dynatrace cria sozinha para cada configuração SNMP | Latência e perda por equipamento, e desde quando parou de responder |
| Circuitos WAN | Tags no monitor de ping dizendo qual circuito ele vigia: identificador, operadora e o SLA contratado | A página de WAN links com SLA por operadora; sem as tags, alcançabilidade por site |

### Alertas e eventos — o que a plataforma e os equipamentos dizem

| Fonte | O que é, em palavras simples | O que destrava no app |
|---|---|---|
| Alertas | Os problemas que o Dynatrace Intelligence abre sobre a rede, a partir dos alert templates e dos alertas do cliente | **Todo status do app.** É a única coisa que pinta vermelho ou amarelo |
| Syslog | As mensagens que os equipamentos enviam sozinhos, recebidas por um ActiveGate | Eventos do equipamento e evidência de causa (vizinho BGP caiu, fonte falhou) |
| Traps SNMP | Avisos que o equipamento dispara na hora em que algo acontece, em vez de esperar ser perguntado | Porta caindo e mudança de roteamento no instante do fato, não na próxima consulta |

### Topologia e roteamento — como os equipamentos se ligam

| Fonte | O que é, em palavras simples | O que destrava no app |
|---|---|---|
| LLDP / CDP | Cada equipamento informa quem está do outro lado do cabo | As rotas entre sites no mapa, desenhadas só onde existe cabo reportado |
| BGP / OSPF | O estado das sessões de roteamento | Se o túnel de cada site está estabelecido, e o salto de Internet |

### Tráfego e aplicações — para onde vai e como se comporta

| Fonte | O que é, em palavras simples | O que destrava no app |
|---|---|---|
| NetFlow / IPFIX | O roteador exporta um resumo de cada conversa que passou por ele, recebido pelo OpenTelemetry Collector | Quem fala com quem e com quais aplicações, rotas com volume real, e achados como varredura ou exportador que parou |
| OneAgent network flows | O agente instalado no servidor observa as conexões dos processos dele | Como a aplicação sente a rede: retransmissão de TCP, tempo de resposta e conexões derrubadas |

### Impacto no usuário — se chegou nas pessoas

| Fonte | O que é, em palavras simples | O que destrava no app |
|---|---|---|
| Sessões | Monitoramento de usuário real (RUM): quantas pessoas estavam usando os sistemas | Isolar a rede: as pessoas continuaram ali enquanto a rede falhava? |
| Requisições | Quando não há RUM, quantas requisições os serviços atenderam | A mesma leitura, por outro caminho |

### Inteligência

| Fonte | O que é, em palavras simples | O que destrava no app |
|---|---|---|
| Assist | O Dynatrace Assist, chamado com o contexto que o app monta do próprio modelo | Explicações, impacto e próximos passos em cada tela |

---

## Custo, escala e confiança

A maior parte do que o app lê **não é cobrada por varredura**: métricas, Smartscape e os problemas da
plataforma são incluídos, e é sobre eles que o inventário, a saúde, a disponibilidade e todos os status são
construídos. Só syslog, traps, NetFlow, fluxos do OneAgent e sessões são cobrados pelo volume que a consulta
varre — por isso o app lê esses em pedaços, guarda no navegador o que já leu, limita cada consulta ao que a
tela consegue mostrar e desliga por 12 horas uma fonte que voltou vazia.

| | |
|---|---|
| **20.000** | equipamentos no teste de escala; acima de três mil o app passa a ler resumos por equipamento |
| **18** | fontes de dados, das quais uma é obrigatória |
| **70** | verificações de cenário contra registros gerados |
| **163** | verificações de coerência sobre a rede de exemplo |

Uma **rede de exemplo** vem embutida — cerca de 550 sites no Brasil e nos Estados Unidos, ou o mesmo grupo com
20 mil equipamentos — para avaliar o app inteiro antes de enviar qualquer dado. Ela passa exatamente pelo
mesmo modelo que um ambiente real.

---

## Glossário rápido

- **SNMP** — o protocolo em que equipamentos de rede respondem perguntas sobre si mesmos: quanto de CPU,
  quanto passou em cada porta, há quanto tempo estão ligados.
- **Syslog e trap** — duas formas de o equipamento falar sem ser perguntado. O syslog é a mensagem de texto;
  a trap é o aviso imediato de um evento.
- **NetFlow / IPFIX** — o resumo que o roteador exporta de cada conversa que passou por ele: origem, destino,
  porta e volume.
- **SLA** — o compromisso de qualidade contratado com a operadora, normalmente um tempo de resposta máximo.
- **ActiveGate** — o componente da Dynatrace instalado na rede do cliente que executa as extensões e recebe
  syslog e traps.
- **Bucket** — a divisão de armazenamento do Grail. Separar os logs de rede em um bucket próprio reduz o
  volume varrido em cada consulta — e a conta.

---

*NetO11y · app do Dynatrace AppEngine · todos os números da rede de exemplo são fictícios e o app identifica
isso na tela.*
