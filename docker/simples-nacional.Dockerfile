# Calculadora da Receita - Simples Nacional (CBS e IBS)
# O banco vem dos scripts do repositorio do regime regular (como manda o README).
FROM maven:3.9-eclipse-temurin-25 AS db
WORKDIR /regime
COPY --from=regime . .
RUN mkdir -p calculadora/db && mvn -B -q flyway:migrate -Dflyway.configFiles=./flyway/flyway-pro.conf

FROM maven:3.9-eclipse-temurin-25 AS build
WORKDIR /src
COPY pom.xml ./
RUN mvn -q -B dependency:go-offline || true
COPY . .
RUN mvn -B -q -DskipTests -Djacoco.skip=true package

FROM eclipse-temurin:25-jre
WORKDIR /app
COPY --from=build /src/target/api-simples-nacional.jar app.jar
COPY --from=db /regime/calculadora/db calculadora/db
EXPOSE 8082
ENTRYPOINT ["java","-Dspring.profiles.active=offline","-jar","app.jar"]
