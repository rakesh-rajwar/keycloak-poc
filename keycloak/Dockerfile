# Keycloak 25's Organizations REST API has a known member-add bug; the
# keycloak-events extension only declares compatibility with the Keycloak
# version pinned in its own pom.xml. Build both from source at matching
# versions rather than guessing at a prebuilt combination.
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN git clone --branch v0.62 --depth 1 https://github.com/p2-inc/keycloak-events.git . \
    && mvn -B -DskipTests -Dspotless.check.skip=true clean package

FROM quay.io/keycloak/keycloak:26.6.3
COPY --from=build /src/target/keycloak-events-*.jar /opt/keycloak/providers/keycloak-events.jar

RUN /opt/keycloak/bin/kc.sh build

ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
