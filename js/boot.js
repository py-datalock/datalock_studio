// boot.js — rede de segurança da tela de carregamento (arquivo externo: a CSP do programa não permite script inline).
// Se depois de alguns segundos a tela de carregamento ainda estiver visível (JS bloqueado, arquivo que não carregou),
// troca a mensagem em vez de deixar a pessoa olhando um spinner sem explicação. Não depende do Vue.
setTimeout(function () {
  var el = document.getElementById("dl-boot-splash-text");
  if (el) {
    el.textContent = "Ainda carregando… se demorar muito, recarregue a página (Ctrl+F5). " +
      "Se estiver no programa instalado, feche e abra de novo.";
  }
}, 6000);
