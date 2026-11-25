# Calculadora da Receita - regime regular (CBS, IBS e Imposto Seletivo)
FROM maven:3.9-eclipse-temurin-25 AS build
WORKDIR /src
COPY pom.xml lombok.config ./
RUN mvn -q -B dependency:go-offline || true
COPY . .
# Gera o banco SQLite com as tabelas oficiais (obrigatorio no perfil offline)
RUN mkdir -p calculadora/db && mvn -B -q flyway:migrate -Dflyway.configFiles=./flyway/flyway-pro.conf
RUN mvn -B -q -DskipTests -Djacoco.skip=true package

FROM eclipse-temurin:25-jre
WORKDIR /app
COPY --from=build /src/target/api-regime-geral.jar app.jar
COPY --from=build /src/calculadora/db calculadora/db
EXPOSE 8080
ENTRYPOINT ["java","-Dspring.profiles.active=offline","-jar","app.jar"]
