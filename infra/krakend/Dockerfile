# Passerelle d'API : KrakenD CE avec la configuration du projet (image "surfwear-gateway").
# La configuration est générée au démarrage (configuration flexible) à partir de krakend.tmpl et settings/,
# selon AUTH_MODE (dev ou auth0), AUTH0_DOMAIN et AUTH0_AUDIENCE.
FROM krakend:3.0.1
COPY krakend.tmpl /etc/krakend/krakend.tmpl
COPY settings /etc/krakend/settings
ENV FC_ENABLE=1 \
    FC_SETTINGS=/etc/krakend/settings
HEALTHCHECK --interval=10s --timeout=3s --retries=10 CMD wget -qO- http://localhost:8080/__health || exit 1
CMD ["krakend", "run", "-c", "/etc/krakend/krakend.tmpl"]
