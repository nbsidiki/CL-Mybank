const path = require("path");
const express = require("express");
const app = express();
const oracledb = require("oracledb");

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
let connection;

async function connectToDatabase() {
    try {
        connection = await oracledb.getConnection({
            user: "admin",
            password: "password",
            connectionString: "0.0.0.0:1521/XEPDB1",
        });
        console.log("Successfully connected to Oracle Database");
    } catch (err) {
        console.error(err);
    }
}

async function setupDatabase() {
    // Suppression des anciennes tables, dev seulement.
    await connection.execute(
        `BEGIN
          execute immediate 'drop table users CASCADE CONSTRAINTS';
          execute immediate 'drop table accounts CASCADE CONSTRAINTS';
          execute immediate 'drop table transactions CASCADE CONSTRAINTS';
          exception when others then if sqlcode <> -942 then raise; end if;
        END;`
    );

    // Création des nouvelles tables, dev seulement.
    await connection.execute(
        `CREATE TABLE users (
          id NUMBER GENERATED ALWAYS AS IDENTITY,
          name VARCHAR2(256),
          email VARCHAR2(512),
          creation_ts TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          accounts NUMBER DEFAULT 0,
          PRIMARY KEY (id)
        )`
    );
    await connection.execute(
        `CREATE TABLE accounts (
          id NUMBER GENERATED ALWAYS AS IDENTITY,
          name VARCHAR2(256),
          amount NUMBER DEFAULT 0,
          user_id NUMBER,
          transactions NUMBER DEFAULT 0,
          CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users (id),
          creation_ts TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id)
        )`
    );

    await connection.execute(
        `CREATE TABLE transactions (
          id NUMBER GENERATED ALWAYS AS IDENTITY,
          name VARCHAR2(256),
          amount NUMBER,
          type NUMBER(1) CHECK (type IN (0, 1)),
          account_id NUMBER,
          CONSTRAINT fk_account FOREIGN KEY (account_id) REFERENCES accounts (id),
          creation_ts TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id)
        )`
    );

    await connection.execute(
        `CREATE OR REPLACE PROCEDURE export_transactions_to_csv (
            p_account_id IN transactions.account_id%TYPE
        ) IS
            v_file UTL_FILE.FILE_TYPE;
            v_line VARCHAR2(32767);
        BEGIN
            v_file := UTL_FILE.FOPEN('EXPORT_DIR', 'transactions.csv', 'W');
            
            UTL_FILE.PUT_LINE(v_file, 'ID,NAME,AMOUNT,TYPE,ACCOUNT_ID');
            
            FOR rec IN (SELECT id, name, amount, type, account_id FROM transactions WHERE account_id = p_account_id) LOOP
                v_line := rec.id || ',' || rec.name || ',' || rec.amount || ',' || rec.type || ',' || rec.account_id;
                UTL_FILE.PUT_LINE(v_file, v_line);
            END LOOP;
            
            UTL_FILE.FCLOSE(v_file);
        EXCEPTION
            WHEN OTHERS THEN
                IF UTL_FILE.IS_OPEN(v_file) THEN
                    UTL_FILE.FCLOSE(v_file);
                END IF;
                RAISE;
        END export_transactions_to_csv;`
    );

    await connection.execute(
        `CREATE OR REPLACE PROCEDURE read_file(p_filename IN VARCHAR2, p_file_content OUT CLOB) IS
            l_file UTL_FILE.FILE_TYPE;
            l_line VARCHAR2(32767);
        BEGIN
            p_file_content := '';
            l_file := UTL_FILE.FOPEN('EXPORT_DIR', p_filename, 'R');
            
            LOOP
                BEGIN
                    UTL_FILE.GET_LINE(l_file, l_line);
                    p_file_content := p_file_content || l_line || CHR(10);
                EXCEPTION
                    WHEN NO_DATA_FOUND THEN
                        EXIT;
                END;
            END LOOP;
            
            UTL_FILE.FCLOSE(l_file);
        EXCEPTION
            WHEN UTL_FILE.INVALID_PATH THEN
                RAISE_APPLICATION_ERROR(-20001, 'Invalid file path');
            WHEN UTL_FILE.READ_ERROR THEN
                RAISE_APPLICATION_ERROR(-20004, 'File read error');
            WHEN OTHERS THEN
                RAISE_APPLICATION_ERROR(-20005, 'An error occurred: ' || SQLERRM);
        END read_file;`
    );

    await connection.execute(
        `CREATE OR REPLACE PROCEDURE insert_user (
            p_user_name IN users.name%TYPE,
            p_user_email IN users.email%TYPE,
            p_user_id OUT users.id%TYPE
        ) AS
        BEGIN
            INSERT INTO users (name, email)
            VALUES (p_user_name, p_user_email)
            RETURNING id INTO p_user_id;
        END;`
    );

    await connection.execute(
        `CREATE OR REPLACE PROCEDURE insert_account (
            p_account_name IN accounts.name%TYPE,
            p_account_amount IN accounts.amount%TYPE,
            p_user_id IN accounts.user_id%TYPE,
            p_account_id OUT accounts.id%TYPE
        ) AS
        BEGIN
            INSERT INTO accounts (name, amount, user_id)
            VALUES (p_account_name, p_account_amount, p_user_id)
            RETURNING id INTO p_account_id;

            UPDATE users
            SET accounts = accounts + 1
            WHERE id = p_user_id;
        END;`
    );

    await connection.execute(
        `CREATE OR REPLACE PROCEDURE insert_transaction (
            p_transaction_name IN transactions.name%TYPE,
            p_transaction_amount IN transactions.amount%TYPE,
            p_transaction_type IN transactions.type%TYPE,
            p_account_id IN transactions.account_id%TYPE,
            p_transaction_id OUT transactions.id%TYPE
        ) AS
            v_formatted_name VARCHAR2(256);
        BEGIN
            -- Appel de la procédure de formatage
            format_transaction_name(p_transaction_type, p_transaction_name, v_formatted_name);

            INSERT INTO transactions (name, amount, type, account_id)
            VALUES (v_formatted_name, p_transaction_amount, p_transaction_type, p_account_id)
            RETURNING id INTO p_transaction_id;

            IF p_transaction_type = 1 THEN -- Entrée
                UPDATE accounts
                SET amount = amount + p_transaction_amount,
                    transactions = transactions + 1
                WHERE id = p_account_id;
            ELSIF p_transaction_type = 0 THEN -- Sortie
                UPDATE accounts
                SET amount = amount - p_transaction_amount,
                    transactions = transactions + 1
                WHERE id = p_account_id;
            END IF;
        END;`
    );

    // Insérer des données
    const usersSql = `INSERT INTO users (name, email, accounts) VALUES(:1, :2, :3)`;
    const usersRows = [
        ["Valentin Montagne", "contact@vm-it-consulting.com", 0],
        ["Amélie Dal", "amelie.dal@gmail.com", 0],
    ];

    await connection.executeMany(usersSql, usersRows);
    const accountsSql = `INSERT INTO accounts (name, amount, user_id) VALUES(:1, :2, :3)`;
    const accountsRows = [["Compte courant", 2000, 1]];
    await connection.executeMany(accountsSql, accountsRows);
    await connection.commit();
}


app.get("/", async (req, res) => {
    res.render("index");
});

app.get("/users", async (req, res) => {
    const getUsersSQL = `select * from users`;
    const result = await connection.execute(getUsersSQL);

    res.json(result.rows);
});

app.get("/accounts", async (req, res) => {
    const getAccountsSQL = `select * from accounts`;
    const result = await connection.execute(getAccountsSQL);

    res.json(result.rows);
});

app.post("/users", async (req, res) => {
    const createUserSQL = `BEGIN
          insert_user(:name, :email, :user_id);
    END;`;
    const result = await connection.execute(createUserSQL, {
        name: req.body.name,
        email: req.body.email,
        user_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    });

    console.log(result);
    if (result.outBinds && result.outBinds.user_id) {
        res.redirect(`/views/${result.outBinds.user_id}`);
    } else {
        res.sendStatus(500);
    }
});

app.post("/accounts", async (req, res) => {
    const createAccountSQL = `BEGIN
          insert_account(:name, :amount, :user_id, :account_id);
    END;`;
    const result = await connection.execute(createAccountSQL, {
        name: req.body.name,
        amount: req.body.amount,
        user_id: req.body.user_id,
        account_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    });

    console.log(result);
    if (result.outBinds && result.outBinds.account_id) {
        res.redirect(`/views/${req.body.user_id}`);
    } else {
        res.sendStatus(500);
    }
});

app.post("/transactions", async (req, res) => {
    const createTransactionSQL = `BEGIN
          insert_transaction(:name, :amount, :type, :account_id, :transaction_id);
    END;`;
    const result = await connection.execute(createTransactionSQL, {
        name: req.body.name,
        amount: req.body.amount,
        type: req.body.type,
        account_id: req.body.account_id,
        transaction_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    });

    console.log(result);
    if (result.outBinds && result.outBinds.transaction_id) {
        res.redirect(`/views/${req.body.user_id}/${req.body.account_id}`);
    } else {
        res.sendStatus(500);
    }
});

app.get("/views/:userId", async (req, res) => {
    const getCurrentUserSQL = `select * from users where id = :1`;
    const getAccountsSQL = `select * from accounts where user_id = :1`;
    const [currentUser, accounts] = await Promise.all([
        connection.execute(getCurrentUserSQL, [req.params.userId]),
        connection.execute(getAccountsSQL, [req.params.userId]),
    ]);

    res.render("user-view", {
        currentUser: currentUser.rows[0],
        accounts: accounts.rows,
    });
});

app.get("/views/:userId/:accountId", async (req, res) => {
    const getCurrentAccountSQL = `select * from accounts where id = :1 and user_id = :2`;
    const getTransactionsSQL = `select * from transactions where account_id = :1`;
    const [currentAccount, transactions] = await Promise.all([
        connection.execute(getCurrentAccountSQL, [req.params.accountId, req.params.userId]),
        connection.execute(getTransactionsSQL, [req.params.accountId]),
    ]);

    res.render("account-view", {
        currentAccount: currentAccount.rows[0],
        transactions: transactions.rows,
    });
});

app.post("/accounts/:accountId/exports", async (req, res) => {
    try {
        await connection.execute(
            `BEGIN
                export_transactions_to_csv(:account_id);
            END;`,
            { account_id: req.params.accountId }
        );
        res.status(200).json({ message: "Export successful" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Export failed" });
    }
});

app.get("/accounts/:accountId/exports", async (req, res) => {
    try {
        const result = await connection.execute(
            `BEGIN
                read_file('transactions.csv', :content);
            END;`,
            {
                content: { dir: oracledb.BIND_OUT, type: oracledb.CLOB },
            }
        );

        const data = await result.outBinds.content.getData();
        res.header('Content-Type', 'text/csv');
        res.attachment('transactions.csv');
        res.send(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to retrieve export" });
    }
});


connectToDatabase().then(async () => {
    await setupDatabase();
    app.listen(3000, () => {
        console.log("Server started on http://localhost:3000");
    });
});
