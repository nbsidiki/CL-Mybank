const path = require("path");
const express = require("express");
const app = express();
const oracledb = require("oracledb");

// Set EJS as the view engine
app.set("view engine", "ejs");

// Define the directory where your HTML files (views) are located
app.set("views", path.join(__dirname, "views"));

// Optionally, you can define a static files directory (CSS, JS, images, etc.)
app.use(express.static(path.join(__dirname, "public")));

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Middleware to handle form data


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
    // Remove old tables, dev only.
    await connection.execute(
        `BEGIN
      execute immediate 'drop table users CASCADE CONSTRAINTS';
      execute immediate 'drop table accounts CASCADE CONSTRAINTS';
      execute immediate 'drop table transactions CASCADE CONSTRAINTS';
      exception when others then if sqlcode <> -942 then raise; end if;
      END;`
    );

    // Create new tables, dev only.
    await connection.execute(
        `create table users (
      id number generated always as identity,
      name varchar2(256),
      email varchar2(512),
      creation_ts timestamp with time zone default current_timestamp,
      accounts number default 0,
      primary key (id)
    )`
    );
    await connection.execute(
        `create table accounts (
      id number generated always as identity,
      name varchar2(256),
      amount number default 0,
      user_id number,
      transactions number default 0,
      CONSTRAINT fk_user
      FOREIGN KEY (user_id)
      REFERENCES users (id),
      creation_ts timestamp with time zone default current_timestamp,
      primary key (id)
  )`
    );

    await connection.execute(
        `create table transactions (
      id number generated always as identity,
      name varchar2(256),
      amount number,
      type number(1) check (type in (0, 1)),
      account_id number,
      CONSTRAINT fk_account
      FOREIGN KEY (account_id)
      REFERENCES accounts (id),
      creation_ts timestamp with time zone default current_timestamp,
      primary key (id)
  )`
    );

    await connection.execute(
        `CREATE OR REPLACE PROCEDURE format_transaction_name (
          p_transaction_type IN transactions.type%TYPE,
          p_transaction_name IN transactions.name%TYPE,
          p_formatted_name OUT VARCHAR2
        ) AS
        BEGIN
          p_formatted_name := 'T' || p_transaction_type || '-' || UPPER(p_transaction_name);
        END;`
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
          -- Call the formatting procedure
          format_transaction_name(p_transaction_type, p_transaction_name, v_formatted_name);

          INSERT INTO transactions (name, amount, type, account_id)
          VALUES (v_formatted_name, p_transaction_amount, p_transaction_type, p_account_id)
          RETURNING id INTO p_transaction_id;

          IF p_transaction_type = 1 THEN -- In transaction
            UPDATE accounts
            SET amount = amount + p_transaction_amount,
                transactions = transactions + 1
            WHERE id = p_account_id;
          ELSIF p_transaction_type = 0 THEN -- Out transaction
            UPDATE accounts
            SET amount = amount - p_transaction_amount,
                transactions = transactions + 1
            WHERE id = p_account_id;
          END IF;
        END;`
    );

    // Insert some data
    const usersSql = `insert into users (name, email, accounts) values(:1, :2, :3)`;
    const usersRows = [
        ["Valentin Montagne", "contact@vm-it-consulting.com", 0],
        ["Amélie Dal", "amelie.dal@gmail.com", 0],
    ];

    await connection.executeMany(usersSql, usersRows);
    const accountsSql = `insert into accounts (name, amount, user_id) values(:1, :2, :3)`;
    const accountsRows = [["Compte courant", 2000, 1]];
    await connection.executeMany(accountsSql, accountsRows);
    connection.commit();
}

// Define routes
app.get("/", async (req, res) => {
    res.render("index"); // Assuming you have an "index.ejs" file in the "views" directory
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
    console.log(currentAccount.rows[0], transactions.rows)
    res.render("account-view", {
        currentAccount: currentAccount.rows[0],
        transactions: transactions.rows,
    });
});

connectToDatabase().then(async () => {
    await setupDatabase();

    app.listen(3000, () => {
        console.log("Server started on http://localhost:3000");
    });
});
